import { access, copyFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const rawDirectory = path.join(projectRoot, "raw_images");
const publicDirectory = path.join(projectRoot, "public");
const outputDirectory = path.join(publicDirectory, "images");
const universeTextureDirectory = path.join(outputDirectory, "universe");
const dataPath = path.join(publicDirectory, "data.json");
const sourceHtmlPath = path.join(projectRoot, "index.html");
const publicHtmlPath = path.join(publicDirectory, "index.html");
const sourceUniverseHtmlPath = path.join(projectRoot, "universe.html");
const publicUniverseHtmlPath = path.join(publicDirectory, "universe.html");
const sourceUniverseScriptPath = path.join(projectRoot, "assets", "js", "universe.js");
const sourceUniverseStylePath = path.join(projectRoot, "assets", "css", "universe.css");
const publicUniverseScriptPath = path.join(publicDirectory, "assets", "js", "universe.js");
const publicUniverseStylePath = path.join(publicDirectory, "assets", "css", "universe.css");
const sourceThreeModulePath = path.join(projectRoot, "node_modules", "three", "build", "three.module.js");
const publicThreeModulePath = path.join(publicDirectory, "vendor", "three.module.js");
const sourceThreeCorePath = path.join(projectRoot, "node_modules", "three", "build", "three.core.js");
const publicThreeCorePath = path.join(publicDirectory, "vendor", "three.core.js");

const MAX_CANVAS_WIDTH = 1920;
// 1500px leaves enough room for adaptive side/bottom borders inside 1920px.
const MAX_PHOTO_WIDTH = 1500;
const WEBP_QUALITY = 80;
const UNIVERSE_TEXTURE_WIDTH = 384;
const UNIVERSE_TEXTURE_QUALITY = 72;
const supportedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"]);

const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);
const pad = number => String(number).padStart(3, "0");

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function orientedDimensions(metadata) {
  const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation);
  return swapsAxes
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

function captionSvg(width, height, index, label, customTitle) {
  const fallbackTitle = `MEMORY ${String(index).padStart(2, "0")}`;
  const displayTitle = String(customTitle || fallbackTitle).slice(0, 34);
  const lengthScale = displayTitle.length > 20 ? 0.72 : displayTitle.length > 14 ? 0.84 : 1;
  const titleSize = Math.round(clamp(width * 0.042, 30, 68) * lengthScale);
  const tagSize = clamp(Math.round(width * 0.018), 16, 28);
  const left = Math.round(width * 0.075);
  const titleY = Math.round(height * 0.46);
  const tagY = Math.round(height * 0.73);

  return Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="${left}" y="${titleY}"
        fill="#25232a" font-size="${titleSize}" font-weight="700"
        font-style="italic" letter-spacing="2"
        font-family="Segoe Print, Comic Sans MS, cursive">${escapeXml(displayTitle)}</text>
      <text x="${left}" y="${tagY}"
        fill="#8a8580" font-size="${tagSize}" font-weight="600"
        letter-spacing="2" font-family="Arial, sans-serif">${escapeXml(label)}</text>
    </svg>
  `);
}

async function readExistingData() {
  try {
    return JSON.parse(await readFile(dataPath, "utf8"));
  } catch {
    return [];
  }
}

async function removeStaleOutputs() {
  const existingFiles = await readdir(outputDirectory, { withFileTypes: true });
  const universeFiles = await readdir(universeTextureDirectory, { withFileTypes: true }).catch(() => []);
  await Promise.all([
    ...existingFiles
    .filter(entry => entry.isFile() && /^memory-\d+\.webp$/i.test(entry.name))
    .map(entry => unlink(path.join(outputDirectory, entry.name))),
    ...universeFiles
      .filter(entry => entry.isFile() && /^memory-\d+\.webp$/i.test(entry.name))
      .map(entry => unlink(path.join(universeTextureDirectory, entry.name)))
  ]);
}

async function processPhoto(fileName, index, existingData) {
  const sourcePath = path.join(rawDirectory, fileName);
  const outputName = `memory-${pad(index + 1)}.webp`;
  const outputPath = path.join(outputDirectory, outputName);
  const metadata = await sharp(sourcePath).metadata();
  const original = orientedDimensions(metadata);

  if (!original.width || !original.height) {
    throw new Error(`无法读取图片尺寸：${fileName}`);
  }

  const aspectRatio = original.width >= original.height ? "landscape" : "portrait";
  const resized = await sharp(sourcePath)
    .rotate()
    .resize({ width: MAX_PHOTO_WIDTH, withoutEnlargement: true })
    .png({ compressionLevel: 6 })
    .toBuffer({ resolveWithObject: true });

  const photoWidth = resized.info.width;
  const photoHeight = resized.info.height;
  const sideBorder = clamp(Math.round(photoWidth * 0.035), 22, 56);
  const topBorder = sideBorder;
  const bottomBorder = clamp(Math.round(photoWidth * 0.18), 112, 280);
  const canvasHeight = photoHeight + topBorder + bottomBorder;
  let canvasWidth = Math.min(photoWidth + sideBorder * 2, MAX_CANVAS_WIDTH);
  if (aspectRatio === "landscape" && canvasWidth <= canvasHeight) {
    canvasWidth = Math.min(MAX_CANVAS_WIDTH, Math.ceil(canvasHeight * 1.08));
  }
  const adjustedSideBorder = Math.floor((canvasWidth - photoWidth) / 2);
  const previous = existingData.find(item => item.sourceFile === fileName)
    || existingData.find(item => !item.sourceFile && Number(item.id) === index + 1)
    || {};
  const category = previous.category || "待整理";
  const event = previous.event || "活动待填写";
  const tag = previous.tag || `#${category} · ${event}`;
  const title = previous.title || `MEMORY ${String(index + 1).padStart(2, "0")}`;

  await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: "#fffdfa"
    }
  })
    .composite([
      { input: resized.data, left: adjustedSideBorder, top: topBorder },
      {
        input: captionSvg(canvasWidth, bottomBorder, index + 1, tag, title),
        left: 0,
        top: topBorder + photoHeight
      }
    ])
    .webp({ quality: WEBP_QUALITY, effort: 6 })
    .toFile(outputPath);

  await sharp(outputPath)
    .resize({ width: UNIVERSE_TEXTURE_WIDTH, withoutEnlargement: true })
    .webp({ quality: UNIVERSE_TEXTURE_QUALITY, effort: 5 })
    .toFile(path.join(universeTextureDirectory, outputName));

  const item = {
    id: index + 1,
    title,
    subtitle: previous.subtitle || "这张照片的故事，等你来填写",
    story: previous.story || "",
    note: previous.note || "",
    location: previous.location || "",
    subImages: Array.isArray(previous.subImages) ? previous.subImages : [],
    tag,
    category,
    event,
    date: previous.date || "日期待填写",
    image: `./images/${outputName}`,
    sourceFile: fileName,
    aspectRatio,
    width: canvasWidth,
    height: canvasHeight
  };

  console.log(`  ${String(index + 1).padStart(2, "0")}. ${aspectRatio.padEnd(9)} ${canvasWidth}×${canvasHeight}  ${fileName}`);
  return item;
}

async function main() {
  await access(rawDirectory);
  await access(sourceHtmlPath);
  await access(sourceUniverseHtmlPath);
  await access(sourceUniverseScriptPath);
  await access(sourceUniverseStylePath);
  await access(sourceThreeModulePath);
  await access(sourceThreeCorePath);
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(universeTextureDirectory, { recursive: true });
  await mkdir(path.dirname(publicUniverseScriptPath), { recursive: true });
  await mkdir(path.dirname(publicUniverseStylePath), { recursive: true });
  await mkdir(path.dirname(publicThreeModulePath), { recursive: true });

  const sourceFiles = (await readdir(rawDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  if (!sourceFiles.length) {
    throw new Error("raw_images/ 中没有找到支持的图片文件。支持 JPG、PNG、WebP 和 TIFF。");
  }

  const existingData = await readExistingData();
  await removeStaleOutputs();
  console.log(`正在处理 ${sourceFiles.length} 张照片…`);

  const data = [];
  for (const [index, fileName] of sourceFiles.entries()) {
    data.push(await processPhoto(fileName, index, existingData));
  }

  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await copyFile(sourceHtmlPath, publicHtmlPath);
  await copyFile(sourceUniverseHtmlPath, publicUniverseHtmlPath);
  await copyFile(sourceUniverseScriptPath, publicUniverseScriptPath);
  await copyFile(sourceUniverseStylePath, publicUniverseStylePath);
  await copyFile(sourceThreeModulePath, publicThreeModulePath);
  await copyFile(sourceThreeCorePath, publicThreeCorePath);
  console.log(`\n完成：${data.length} 张 WebP 已输出到 public/images/`);
  console.log(`宇宙纹理：${data.length} 张 ${UNIVERSE_TEXTURE_WIDTH}px WebP 已输出到 public/images/universe/`);
  console.log("资料索引：public/data.json");
  console.log("网站入口：public/index.html · public/universe.html");
}

main().catch(error => {
  console.error(`\n构建失败：${error.message}`);
  process.exitCode = 1;
});
