
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { randomUUID } from "node:crypto";

import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Đọc file .env.local từ thư mục gốc dự án
dotenv.config({ path: "../.env.local" });

const app = express();
const PORT = Number(process.env.PORT || 3001);

const BUCKET = process.env.R2_BUCKET_NAME;
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;

// Sử dụng đúng tên biến môi trường hiện có của dự án
const SUPABASE_URL = process.env.VITE_SUPABASE_URL?.replace(/\/+$/, "");
const SUPABASE_PUBLISHABLE_KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024; // 20 GiB
const PART_SIZE = 10 * 1024 * 1024; // 10 MiB
const MAX_PARTS = 10000;
const SIGNED_URL_EXPIRY = 3600;

if (
  !ACCOUNT_ID ||
  !process.env.R2_ACCESS_KEY_ID ||
  !process.env.R2_SECRET_ACCESS_KEY ||
  !BUCKET
) {
  throw new Error(
    "Thiếu R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY hoặc R2_BUCKET_NAME trong .env.local"
  );
}

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error(
    "Thiếu VITE_SUPABASE_URL hoặc VITE_SUPABASE_PUBLISHABLE_KEY trong .env.local"
  );
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const allowedOrigins = (
  process.env.FRONTEND_ORIGIN || "http://localhost:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin không được phép"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "1mb" }));

// ------------------------------------------------------------------
// Các hàm dùng chung
// ------------------------------------------------------------------

function validateVideo(fileName, contentType, size) {
  if (
    typeof fileName !== "string" ||
    !fileName.trim() ||
    fileName.length > 255
  ) {
    throw new Error("Tên file không hợp lệ");
  }

  if (
    typeof contentType !== "string" ||
    !contentType.startsWith("video/")
  ) {
    throw new Error("Chỉ chấp nhận file video");
  }

  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_FILE_SIZE
  ) {
    throw new Error("Video phải có dung lượng từ 1 byte đến 20 GiB");
  }

  if (Math.ceil(size / PART_SIZE) > MAX_PARTS) {
    throw new Error("Video có quá nhiều phần upload");
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} không hợp lệ`);
  }

  return value;
}

function validateVideoKey(key) {
  requireString(key, "key");

  if (
    !key.startsWith("videos/") ||
    key.length > 1024 ||
    key.includes("..")
  ) {
    throw new Error("Key video không hợp lệ");
  }
}

function sendError(res, error, fallback) {
  console.error(fallback, error);

  if (res.headersSent) return;

  const message =
    error instanceof Error ? error.message : fallback;

  res.status(400).json({
    error: message || fallback,
  });
}

// ------------------------------------------------------------------
// Xác thực Supabase và quyền admin
// ------------------------------------------------------------------

async function requireAdmin(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        error: "Vui lòng đăng nhập bằng tài khoản quản trị.",
      });
    }

    const accessToken = match[1];

    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      return res.status(401).json({
        error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
      });
    }

    const currentUser = await response.json();

    if (currentUser?.app_metadata?.role !== "admin") {
      return res.status(403).json({
        error: "Tài khoản không có quyền quản trị.",
      });
    }

    req.adminUser = currentUser;
    next();
  } catch (error) {
    console.error("Admin authentication error:", error);

    return res.status(500).json({
      error: "Không thể xác minh quyền quản trị.",
    });
  }
}

// ------------------------------------------------------------------
// Health check
// ------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    service: "R2 upload API",
  });
});

// ------------------------------------------------------------------
// 1. Khởi tạo multipart upload
// ------------------------------------------------------------------

app.post("/api/uploads/init", requireAdmin, async (req, res) => {
  try {
    const { fileName, contentType, size } = req.body || {};

    validateVideo(fileName, contentType, size);

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `videos/${randomUUID()}-${safeName}`;

    const result = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: contentType,
      })
    );

    if (!result.UploadId) {
      throw new Error("R2 không trả về UploadId");
    }

    return res.json({
      key,
      uploadId: result.UploadId,
      partSize: PART_SIZE,
      partCount: Math.ceil(size / PART_SIZE),
    });
  } catch (error) {
    return sendError(res, error, "Không thể bắt đầu upload");
  }
});

// ------------------------------------------------------------------
// 2. Tạo signed URL cho từng phần upload
// ------------------------------------------------------------------

app.post("/api/uploads/part-url", requireAdmin, async (req, res) => {
  try {
    const { key, uploadId, partNumber } = req.body || {};

    validateVideoKey(key);
    requireString(uploadId, "uploadId");

    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > MAX_PARTS
    ) {
      return res.status(400).json({
        error: "Số thứ tự phần upload không hợp lệ",
      });
    }

    const url = await getSignedUrl(
      s3,
      new UploadPartCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      {
        expiresIn: SIGNED_URL_EXPIRY,
      }
    );

    return res.json({ url });
  } catch (error) {
    return sendError(res, error, "Không tạo được URL upload");
  }
});

// ------------------------------------------------------------------
// 3. Hoàn tất multipart upload
// ------------------------------------------------------------------

app.post("/api/uploads/complete", requireAdmin, async (req, res) => {
  try {
    const { key, uploadId, parts } = req.body || {};

    validateVideoKey(key);
    requireString(uploadId, "uploadId");

    if (
      !Array.isArray(parts) ||
      parts.length < 1 ||
      parts.length > MAX_PARTS
    ) {
      return res.status(400).json({
        error: "Danh sách phần upload không hợp lệ",
      });
    }

    const normalizedParts = parts.map((part) => {
      if (
        !Number.isInteger(part?.PartNumber) ||
        part.PartNumber < 1 ||
        typeof part.ETag !== "string" ||
        !part.ETag.trim()
      ) {
        throw new Error("Part hoặc ETag không hợp lệ");
      }

      return {
        PartNumber: part.PartNumber,
        ETag: part.ETag,
      };
    });

    normalizedParts.sort((a, b) => a.PartNumber - b.PartNumber);

    for (let i = 0; i < normalizedParts.length; i++) {
      if (normalizedParts[i].PartNumber !== i + 1) {
        throw new Error("Danh sách part bị thiếu hoặc trùng");
      }
    }

    const result = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: normalizedParts,
        },
      })
    );

    return res.json({
      success: true,
      key,
      etag: result.ETag,
    });
  } catch (error) {
    return sendError(res, error, "Không thể hoàn tất upload");
  }
});

// ------------------------------------------------------------------
// 4. Hủy multipart upload chưa hoàn tất
// ------------------------------------------------------------------

app.post("/api/uploads/abort", requireAdmin, async (req, res) => {
  try {
    const { key, uploadId } = req.body || {};

    validateVideoKey(key);
    requireString(uploadId, "uploadId");

    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: uploadId,
      })
    );

    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, "Không thể hủy upload");
  }
});

// ------------------------------------------------------------------
// 5. Xóa video trên R2
// ------------------------------------------------------------------

app.post("/api/objects/delete", requireAdmin, async (req, res) => {
  try {
    const { key } = req.body || {};

    validateVideoKey(key);

    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: key,
      })
    );

    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, "Không thể xóa video trên R2");
  }
});

// ------------------------------------------------------------------
// Xử lý lỗi middleware
// ------------------------------------------------------------------

app.use((error, _req, res, _next) => {
  console.error("API middleware error:", error);

  if (res.headersSent) return;

  res.status(500).json({
    error: "Lỗi máy chủ hoặc yêu cầu không được phép.",
  });
});

// ------------------------------------------------------------------
// Khởi động server
// ------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`R2 Upload API đang chạy tại http://localhost:${PORT}`);
});
