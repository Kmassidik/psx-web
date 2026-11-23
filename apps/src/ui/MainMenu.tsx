import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DisplayScale } from "../state/config";
import { resetConfig, setConfig, setState, useApp, type RunState } from "./store";

export type FileMode = "auto" | "exe" | "bios";
export type DialogName = "video" | "sound" | "gamepad" | "memcard" | "about";

interface MenuItemProps {
  label: string;
  action?: () => void;
  checked?: boolean;
  disabled?: boolean;
  reason?: string;
  children?: ReactNode;
}

function MenuItem({ label, action, checked, disabled, reason, children }: MenuItemProps) {
  const submenu = children !== undefined;
  const title = disabled ? (reason ?? "This action is not available in this build.") : undefined;
  return (
    <li className={submenu ? "menu-has-submenu" : ""} role="none" title={title}>
      <button
        type="button"
        className="menu-item"
        role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked={checked}
        aria-haspopup={submenu || undefined}
        data-command={action ? "" : undefined}
        disabled={disabled}
        title={title}
        onClick={action}
      >
        <span className="menu-mark" aria-hidden="true">{checked ? "✓" : ""}</span>
        <span className="menu-label">{label}</span>
        {submenu && <span className="submenu-arrow" aria-hidden="true">▶</span>}
      </button>
      {submenu && <ul className="menu-popup submenu" role="menu">{children}</ul>}
    </li>
  );
}

function MenuSeparator() {
  return <li className="menu-separator" role="separator"><hr /></li>;
}

interface TopMenuProps {
  name: string;
  openMenu: string | null;
  setOpenMenu: (name: string | null) => void;
  children: ReactNode;
}

function TopMenu({ name, openMenu, setOpenMenu, children }: TopMenuProps) {
  return (
    <div className={`top-menu${name === "Help" ? " help-menu" : ""}`}>
      <button
        type="button"
        className={`menu-top${openMenu === name ? " is-open" : ""}`}
        aria-expanded={openMenu === name}
        aria-haspopup="true"
        onClick={() => setOpenMenu(openMenu === name ? null : name)}
        onMouseEnter={() => { if (openMenu) setOpenMenu(name); }}
      >{name}</button>
      {openMenu === name && <ul className="menu-popup" role="menu">{children}</ul>}
    </div>
  );
}

interface MainMenuProps {
  run: RunState;
  hasMachine: boolean;
  canStop: boolean;
  fullscreen: boolean;
  fullscreenSupported: boolean;
  onOpenFile: (mode: FileMode) => void;
  onOpenDialog: (name: DialogName, padPort?: 1 | 2) => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
  onStop: () => void;
  onSaveState: (slot: number) => void;
  onLoadState: (slot: number) => void;
  onToggleFullscreen: () => void;
}

const stateSlots = [1, 2, 3, 4, 5];
const overclockRates = [1, 1.5, 2, 3, 4];
const scaleLabels: Array<[DisplayScale, string]> = [
  ["fit", "Fit (preserve aspect ratio)"],
  ["integer", "Integer (native pixels)"],
  ["stretch", "Stretch (fill window)"],
];

export function MainMenu(props: MainMenuProps) {
  const { run, hasMachine, canStop, fullscreen, fullscreenSupported } = props;
  const config = useApp((s) => s.config);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const onPointer = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);
  const openDialog = (name: DialogName, padPort?: 1 | 2) => {
    setOpenMenu(null);
    props.onOpenDialog(name, padPort);
  };
  const unavailable = (feature: string) => `${feature} is not connected to the emulator in this build.`;

  return (
    <nav
      ref={navRef}
      className="menu-bar"
      aria-label="ePSXe main menu"
      onClick={(event) => {
        event.stopPropagation();
        if ((event.target as HTMLElement).closest("[data-command]")) setOpenMenu(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpenMenu(null);
          return;
        }
        const target = event.target as HTMLElement;
        if (!target.classList.contains("menu-top") || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        const tops = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".menu-top"));
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const next = tops[(tops.indexOf(target as HTMLButtonElement) + direction + tops.length) % tops.length];
        next?.focus();
        if (openMenu) setOpenMenu(next?.textContent ?? null);
      }}
    >
      <TopMenu name="File" openMenu={openMenu} setOpenMenu={setOpenMenu}>
        <MenuItem label="Run CD-ROM" disabled reason={unavailable("Physical CD-ROM access")} />
        <MenuItem label="Run ISO" disabled reason="ISO/CUE loading is unavailable. Drop an MDF image on the display instead." />
        <MenuItem label="Run PS-EXE" action={() => props.onOpenFile("exe")} />
        <MenuItem label="Run BIOS" action={() => props.onOpenFile("bios")} />
        <MenuSeparator />
        <MenuItem label="Open Gamelist" disabled reason={unavailable("The game library")} />
        <MenuSeparator />
        <MenuItem label="Local Netplay">
          <MenuItem label="Player 1" disabled reason={unavailable("Netplay")} />
          <MenuItem label="Player 2" disabled reason={unavailable("Netplay")} />
        </MenuItem>
        <MenuSeparator />
        <MenuItem label="Change Disc">
          <MenuItem label="CD-ROM" disabled reason={unavailable("Physical disc switching")} />
          <MenuItem label="ISO" disabled reason={unavailable("Disc switching")} />
        </MenuItem>
        <MenuSeparator />
        <MenuItem label="Exit" disabled reason="Use the browser tab/window controls to exit this client-side emulator." />
      </TopMenu>

      <TopMenu name="Run" openMenu={openMenu} setOpenMenu={setOpenMenu}>
        <MenuItem
          label="Continue"
          disabled={run !== "paused"}
          reason="Continue is available while a game is paused."
          action={props.onResume}
        />
        <MenuItem
          label="Pause"
          disabled={run !== "running"}
          reason="Pause is available while a game is running."
          action={props.onPause}
        />
        <MenuSeparator />
        <MenuItem
          label="Reset"
          disabled={!hasMachine}
          reason="Load a PS-X EXE, MDF, or BIOS before resetting."
          action={props.onReset}
        />
        <MenuItem
          label="Stop"
          disabled={!canStop}
          reason="No loaded program is active."
          action={props.onStop}
        />
        <MenuSeparator />
        <MenuItem label="Save State (F1)">
          {stateSlots.map((slot) => (
            <MenuItem key={slot} label={`Slot ${slot}`} disabled={!hasMachine} reason="Load a game before saving state." action={() => props.onSaveState(slot)} />
          ))}
        </MenuItem>
        <MenuItem label="Load State (F3)">
          {stateSlots.map((slot) => (
            <MenuItem key={slot} label={`Slot ${slot}`} disabled={!hasMachine} reason="Load the same game before restoring state." action={() => props.onLoadState(slot)} />
          ))}
        </MenuItem>
      </TopMenu>

      <TopMenu name="Config" openMenu={openMenu} setOpenMenu={setOpenMenu}>
        <MenuItem label="Plugins">
          <MenuItem label="Video" disabled reason="The built-in native video renderer is always used; external plugins are unsupported." />
          <MenuItem label="Sound" disabled reason={unavailable("External audio plugins")} />
          <MenuItem label="Input Port 1" disabled reason="Use Config → Game Pads → Port 1 → Pad 1 for keyboard mappings." />
          <MenuItem label="Input Port 2" disabled reason="Use Config → Game Pads → Port 2 → Pad 1 for keyboard mappings." />
        </MenuItem>
        <MenuItem label="Video" action={() => openDialog("video")} />
        <MenuItem label="Sound" action={() => openDialog("sound")} />
        <MenuItem label="Cd-rom" disabled reason="There are no configurable CD-ROM settings in this build." />
        <MenuItem label="Game Pads">
          <MenuItem label="Port 1">
            <MenuItem label="Pad 1" action={() => openDialog("gamepad", 1)} />
            <MenuItem label="Pad 2" disabled reason={unavailable("Multitap pads")} />
            <MenuItem label="Pad 3" disabled reason={unavailable("Multitap pads")} />
            <MenuItem label="Pad 4" disabled reason={unavailable("Multitap pads")} />
            <MenuItem label="Multitap" disabled reason={unavailable("Multitap support")} />
            <MenuItem label="Autofire Pad 1" disabled reason={unavailable("Autofire")} />
          </MenuItem>
          <MenuItem label="Port 2">
            <MenuItem label="Pad 1" action={() => openDialog("gamepad", 2)} />
            <MenuItem label="Pad 2" disabled reason={unavailable("Multitap pads")} />
            <MenuItem label="Pad 3" disabled reason={unavailable("Multitap pads")} />
            <MenuItem label="Pad 4" disabled reason={unavailable("Multitap pads")} />
            <MenuItem label="Multitap" disabled reason={unavailable("Multitap support")} />
            <MenuItem label="Autofire Pad 2" disabled reason={unavailable("Autofire")} />
          </MenuItem>
        </MenuItem>
        <MenuSeparator />
        <MenuItem label="Bios" disabled reason="Use File → Run BIOS to select a session-local BIOS image." />
        <MenuSeparator />
        <MenuItem label="Memory card" action={() => openDialog("memcard")} />
      </TopMenu>

      <TopMenu name="Options" openMenu={openMenu} setOpenMenu={setOpenMenu}>
        <MenuItem label="Display Mode">
          {scaleLabels.map(([mode, label]) => (
            <MenuItem
              key={mode}
              label={label}
              checked={config.DisplayScale === mode}
              action={() => setConfig({ DisplayScale: mode })}
            />
          ))}
        </MenuItem>
        <MenuItem
          label={fullscreen ? "Exit Full Screen (F11)" : "Full Screen (F11)"}
          disabled={!fullscreenSupported}
          reason="This browser does not allow the Fullscreen API."
          action={props.onToggleFullscreen}
        />
        <MenuItem label="Show FPS" checked={config.ShowFPS} action={() => setConfig({ ShowFPS: !config.ShowFPS })} />
        <MenuSeparator />
        <MenuItem label="CPU Overclocking">
          {overclockRates.map((rate) => (
            <MenuItem key={rate} label={`x${rate}`} checked={rate === 1} disabled reason={unavailable("CPU overclocking")} />
          ))}
        </MenuItem>
        <MenuItem label="CPU Mode">
          <MenuItem label="Dynarec (fast)" checked={config.Dynarec} action={() => setConfig({ Dynarec: true })} />
          <MenuItem label="Interpreter (Accurate)" checked={!config.Dynarec} action={() => setConfig({ Dynarec: false })} />
        </MenuItem>
        <MenuItem label="GTE hacks">
          <MenuItem label="Widescreen" checked={false} disabled reason={unavailable("The widescreen GTE hack")} />
          <MenuItem label="Subpixel precision" disabled reason={unavailable("Subpixel precision")} />
        </MenuItem>
        <MenuItem label="Auto load ppf files" disabled reason={unavailable("PPF patches")} />
        <MenuItem label="Cheat codes" disabled reason={unavailable("Cheat codes")} />
        <MenuItem label="Game Profiles">
          <MenuItem label="Save Profile" disabled reason={unavailable("Game profiles")} />
          <MenuItem label="Delete Profile" disabled reason={unavailable("Game profiles")} />
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          label="Reset Defaults"
          action={() => {
            resetConfig();
            setState({ statusLine: "Settings reset to defaults", lastError: "" });
          }}
        />
      </TopMenu>

      <TopMenu name="Help" openMenu={openMenu} setOpenMenu={setOpenMenu}>
        <MenuItem label="Visit ePSXe website" action={() => window.open("https://www.epsxe.com", "_blank", "noopener,noreferrer")} />
        <MenuSeparator />
        <MenuItem label="About" action={() => openDialog("about")} />
      </TopMenu>
    </nav>
  );
}
