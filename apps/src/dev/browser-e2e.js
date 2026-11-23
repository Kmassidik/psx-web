/*
 * Run inside the repository's Puppeteer browser harness with:
 *   tab.run(<this file's source>)
 * Requires PSX_E2E_URL (default http://localhost:5174) and PSX_E2E_EXE in the
 * harness environment; no game data is sent anywhere except the local page.
 */
const url = process.env.PSX_E2E_URL ?? "http://localhost:5174";
const executable = process.env.PSX_E2E_EXE ?? "/tmp/psx-hello.exe";
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const bodyText = () => page.evaluate(() => document.body.innerText);
const clickButton = async (text) => {
  const handles = await page.$$("button");
  for (const handle of handles) {
    const value = await handle.evaluate((button) => button.textContent?.trim());
    const actionable = await handle.evaluate((button) => !button.disabled && button.offsetParent !== null);
    if (value === text && actionable) {
      await handle.evaluate((button) => button.click());
      return;
    }
  }
  throw new Error(`Button not found: ${text}`);
};

await page.goto(url, { waitUntil: "networkidle0" });
const input = await page.$('input[type="file"]');
assert(input, "File input is present");
await input.uploadFile(executable);
await page.waitForFunction(() => document.body.innerText.includes("running psx-hello.exe"));
await page.waitForFunction(() => {
  const canvas = document.querySelector("canvas");
  if (!canvas) return false;
  const context = canvas.getContext("2d");
  if (!context) return false;
  const pixel = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
  return pixel[0] === 0 && pixel[1] === 255 && pixel[2] === 0 && pixel[3] === 255;
});

await clickButton("Run");
await clickButton("Pause");
await page.waitForFunction(() => document.body.innerText.includes("paused psx-hello.exe"));
await clickButton("Run");
await clickButton("Continue");
await page.waitForFunction(() => document.body.innerText.includes("running psx-hello.exe"));
await clickButton("Run");
await clickButton("Reset");
await page.waitForFunction(() => document.body.innerText.includes("running psx-hello.exe"));

await clickButton("Options");
await clickButton("Full Screen (F11)");
await page.waitForFunction(() => Boolean(document.fullscreenElement));
await page.keyboard.press("F11");
await page.waitForFunction(() => !document.fullscreenElement);

await clickButton("Config");
await clickButton("Sound");
await page.waitForFunction(() => document.body.innerText.includes("SPU Audio"));
await page.waitForFunction(() => document.body.innerText.includes("Status: running"));
const mute = await page.$('input[type="checkbox"]');
assert(mute, "Mute checkbox is present");
await mute.click();
assert(await mute.evaluate((element) => element.checked), "Mute changes state");
await page.focus("#audio-volume");
await page.keyboard.press("Home");
await page.keyboard.press("ArrowRight");
const volume = await page.$eval("#audio-volume", (element) => element.value);
assert(Number(volume) > 0 && Number(volume) <= 0.02, `Volume slider changed: ${volume}`);
await clickButton("Close");
console.log("E2E stage: audio controls passed");

await page.keyboard.press("F1");
console.log("E2E stage: F1 pressed");
await page.waitForFunction(() => document.body.innerText.includes("saved state 1"));
await clickButton("Run");
await clickButton("Reset");
await page.waitForFunction(() => document.body.innerText.includes("running psx-hello.exe"));
await page.keyboard.press("F3");
await page.waitForFunction(() => document.body.innerText.includes("loaded state 1"));
console.log("E2E stage: save/load state passed");

await clickButton("Config");
await clickButton("Memory card");
await page.waitForFunction(() => document.body.innerText.includes("Select Memcards files"));
await clickButton("Format");
await page.waitForFunction(() => document.body.innerText.includes("Slot 1 formatted and saved locally"));
const downloadWait = tab.waitForDownload();
await clickButton("Export");
const cardDownload = await downloadWait;
assert(cardDownload.suggestedFilename === "slot1.mcr", "Memory-card export uses the configured filename");
await clickButton("Eject");
await page.waitForFunction(() => document.body.innerText.includes("Slot 1 ejected; stored data was kept"));

console.log(JSON.stringify({
  greenFrame: true,
  pauseContinueReset: true,
  fullscreen: true,
  audioUnlockMuteVolume: true,
  saveLoadState: true,
  memoryCardFormatExportEject: true,
  status: await bodyText(),
}, null, 2));
