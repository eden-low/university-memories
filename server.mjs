import crypto from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import express from "express";
import multer from "multer";

const execFileAsync = promisify(execFile);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(projectRoot, "public");
const rawDirectory = path.join(projectRoot, "raw_images");
const dataPath = path.join(publicDirectory, "data.json");
const processScript = path.join(projectRoot, "scripts", "process-images.mjs");
const host = "127.0.0.1";
const port = Number(process.env.PORT) || 8000;
const maxUploadBytes = 30 * 1024 * 1024;
const allowedTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/tiff", ".tiff"]
]);

await mkdir(rawDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination: rawDirectory,
  filename(request, file, callback) {
    const extension = allowedTypes.get(file.mimetype) || ".jpg";
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    callback(null, `zz-upload-${timestamp}-${crypto.randomUUID().slice(0, 8)}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: maxUploadBytes, files: 1, fields: 8 },
  fileFilter(request, file, callback) {
    if (!allowedTypes.has(file.mimetype)) {
      callback(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "image"));
      return;
    }
    callback(null, true);
  }
});

const app = express();
let pipelineBusy = false;
const uploadToken = crypto.randomBytes(32).toString("hex");

function cleanText(value, maximumLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}

async function run(command, args) {
  return execFileAsync(command, args, {
    cwd: projectRoot,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });
}

async function readGalleryData() {
  try {
    const parsed = JSON.parse(await readFile(dataPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

app.get("/api/health", (request, response) => {
  response.json({ ok: true, busy: pipelineBusy, localOnly: true, uploadToken });
});

app.post("/api/upload", (request, response) => {
  if (request.get("x-local-upload-token") !== uploadToken) {
    response.status(403).json({ success: false, message: "上传会话无效，请刷新本地页面。" });
    return;
  }
  if (pipelineBusy) {
    response.status(409).json({ success: false, message: "已有一张照片正在处理，请稍后再试。" });
    return;
  }

  pipelineBusy = true;
  upload.single("image")(request, response, async uploadError => {
    if (uploadError) {
      pipelineBusy = false;
      const tooLarge = uploadError.code === "LIMIT_FILE_SIZE";
      response.status(400).json({
        success: false,
        message: tooLarge ? "图片不能超过 30MB。" : "只支持 JPG、PNG、WebP 或 TIFF 图片。"
      });
      return;
    }

    if (!request.file) {
      pipelineBusy = false;
      response.status(400).json({ success: false, message: "请选择一张照片。" });
      return;
    }

    const title = cleanText(request.body.title, 60);
    const subtitle = cleanText(request.body.subtitle, 140);
    const date = cleanText(request.body.date, 40);
    const category = cleanText(request.body.category, 30).replace(/^#+/, "") || "待整理";
    const location = cleanText(request.body.location, 60);
    const story = cleanText(request.body.story, 500);

    if (!title) {
      await unlink(request.file.path).catch(() => {});
      pipelineBusy = false;
      response.status(400).json({ success: false, message: "请填写回忆标题。" });
      return;
    }

    let originalDataText = "[]\n";
    try {
      try {
        originalDataText = await readFile(dataPath, "utf8");
      } catch {
        // The processing script can create data.json from scratch.
      }

      const currentData = await readGalleryData();
      const nextId = currentData.reduce((maximum, item) => Math.max(maximum, Number(item.id) || 0), 0) + 1;
      currentData.push({
        id: nextId,
        title,
        subtitle: subtitle || story || "一张刚刚加入的大学回忆",
        story,
        note: "",
        location,
        subImages: [],
        date: date || "日期待填写",
        category,
        event: "新上传",
        tag: `#${category}`,
        sourceFile: request.file.filename,
        image: "",
        aspectRatio: "pending"
      });
      await writeFile(dataPath, `${JSON.stringify(currentData, null, 2)}\n`, "utf8");

      try {
        await run(process.execPath, [processScript]);
      } catch (buildError) {
        await writeFile(dataPath, originalDataText, "utf8");
        throw Object.assign(new Error("图片已保存，但自动处理失败。请查看本地终端日志。"), {
          stage: "build",
          detail: buildError.stderr || buildError.message
        });
      }

      try {
        await run("git", ["add", "."]);
        await run("git", ["commit", "-m", `Add new memory: ${title}`]);
        await run("git", ["push"]);
      } catch (gitError) {
        throw Object.assign(new Error("图片处理成功，但 Git 同步失败。请在终端检查 git status 后重试。"), {
          stage: "git",
          detail: gitError.stderr || gitError.message
        });
      }

      const { stdout: commitHash } = await run("git", ["rev-parse", "--short", "HEAD"]);
      response.json({
        success: true,
        message: "回忆已处理并推送到 GitHub。",
        commit: commitHash.trim(),
        sourceFile: request.file.filename
      });
    } catch (error) {
      console.error(`[${error.stage || "upload"}] ${error.message}`);
      if (error.detail) console.error(error.detail);
      response.status(500).json({
        success: false,
        stage: error.stage || "upload",
        message: error.message || "上传处理失败。"
      });
    } finally {
      pipelineBusy = false;
    }
  });
});

app.use(express.static(publicDirectory, {
  extensions: ["html"],
  etag: true,
  maxAge: 0
}));

app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) return next(error);
  response.status(500).json({ success: false, message: "本地服务发生错误。" });
});

app.listen(port, host, () => {
  console.log(`\nUniversity Memories local manager`);
  console.log(`http://${host}:${port}`);
  console.log("上传接口仅绑定本机，不会暴露到局域网。\n");
});
