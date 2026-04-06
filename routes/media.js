const express = require('express');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const MediaAsset = require('../models/MediaAsset');
const { authenticate, requireStatus } = require('../middleware/auth');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();
const STORAGE_ROOT = path.join(__dirname, '..', 'storage');
const MEDIA_ROOT = path.join(STORAGE_ROOT, 'media');
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

router.use(authenticate, requireStatus('active'));

const sanitizeName = (value, fallback = 'asset') =>
  String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || fallback;

const extensionFromMime = (mimeType = '') => {
  const normalized = String(mimeType).toLowerCase();
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'video/mp4') return '.mp4';
  if (normalized === 'video/webm') return '.webm';
  if (normalized === 'audio/mpeg') return '.mp3';
  if (normalized === 'audio/mp4') return '.m4a';
  if (normalized === 'audio/ogg') return '.ogg';
  if (normalized === 'application/pdf') return '.pdf';
  return '';
};

const inferAssetType = (mimeType = '', fileName = '') => {
  const normalizedMime = String(mimeType).toLowerCase();
  const normalizedName = String(fileName).toLowerCase();
  if (normalizedMime.startsWith('image/')) return 'image';
  if (normalizedMime.startsWith('video/')) return 'video';
  if (normalizedMime.startsWith('audio/')) return 'audio';
  if (normalizedMime || /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|zip)$/i.test(normalizedName)) return 'document';
  return 'document';
};

const parseDataUrl = (value) => {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:([^,]+),(.+)$/);
  if (!match) {
    throw new Error('Upload payload must be a valid base64 data URL');
  }
  const meta = String(match[1] || '');
  const payload = String(match[2] || '');
  if (!/;base64$/i.test(meta)) {
    throw new Error('Upload payload must include ;base64 marker');
  }
  const mimeType = meta.split(';')[0].trim();
  if (!mimeType) {
    throw new Error('Upload payload is missing MIME type');
  }

  return {
    mimeType,
    buffer: Buffer.from(payload, 'base64'),
  };
};

const buildBaseUrl = (req) => {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return `${forwardedProto}://${forwardedHost}`;
};

const toClientAsset = (asset) => ({
  _id: asset._id,
  asset_type: asset.asset_type,
  original_name: asset.original_name,
  stored_name: asset.stored_name,
  mime_type: asset.mime_type,
  size_bytes: asset.size_bytes,
  public_url: asset.public_url,
  created_at: asset.created_at,
  updated_at: asset.updated_at,
});

router.get('/assets', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const assetType = String(req.query.asset_type || '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);

    const query = { tenant_id: req.tenant._id };
    if (assetType && ['image', 'video', 'document', 'audio'].includes(assetType)) {
      query.asset_type = assetType;
    }
    if (search) {
      query.original_name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    const assets = await MediaAsset.find(query).sort({ created_at: -1 }).limit(limit);
    const countsAgg = await MediaAsset.aggregate([
      { $match: { tenant_id: req.tenant._id } },
      { $group: { _id: '$asset_type', count: { $sum: 1 } } },
    ]);

    const counts = countsAgg.reduce(
      (accumulator, item) => ({ ...accumulator, [item._id]: item.count }),
      { image: 0, video: 0, document: 0, audio: 0 }
    );

    return apiResponse(res, {
      data: {
        assets: assets.map(toClientAsset),
        counts,
      },
    });
  } catch (error) {
    console.error('[Media Route] Failed to list assets', error);
    return apiResponse(res, {
      status: 500,
      success: false,
      error: 'Failed to load media library',
    });
  }
});

router.post('/assets/upload', async (req, res) => {
  try {
    const { data_url, original_name, mime_type } = req.body || {};
    if (!data_url || !original_name) {
      return apiResponse(res, {
        status: 400,
        success: false,
        error: 'data_url and original_name are required',
      });
    }

    const parsed = parseDataUrl(data_url);
    const detectedMimeType = String(mime_type || parsed.mimeType || '').trim().toLowerCase();
    const assetType = inferAssetType(detectedMimeType, original_name);

    if (parsed.buffer.length > MAX_UPLOAD_BYTES) {
      return apiResponse(res, {
        status: 400,
        success: false,
        error: 'Each upload must be 15 MB or smaller',
      });
    }

    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const extension = path.extname(original_name) || extensionFromMime(detectedMimeType);
    const safeName = sanitizeName(path.basename(original_name, path.extname(original_name)));
    const storedName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName}${extension}`;
    const relativePath = path.posix.join('media', String(req.tenant._id), year, month, storedName);
    const absoluteDir = path.join(MEDIA_ROOT, String(req.tenant._id), year, month);
    const absolutePath = path.join(STORAGE_ROOT, relativePath);

    await fs.mkdir(absoluteDir, { recursive: true });
    await fs.writeFile(absolutePath, parsed.buffer);

    const publicUrl = `${buildBaseUrl(req)}/uploads/${relativePath}`;
    const asset = await MediaAsset.create({
      tenant_id: req.tenant._id,
      created_by: req.user?._id || null,
      asset_type: assetType,
      original_name: original_name,
      stored_name: storedName,
      mime_type: detectedMimeType || 'application/octet-stream',
      size_bytes: parsed.buffer.length,
      relative_path: relativePath,
      public_url: publicUrl,
    });

    return apiResponse(res, {
      status: 201,
      data: {
        asset: toClientAsset(asset),
      },
    });
  } catch (error) {
    console.error('[Media Route] Failed to upload asset', error);
    return apiResponse(res, {
      status: 500,
      success: false,
      error: error.message || 'Failed to upload asset',
    });
  }
});

router.delete('/assets/:assetId', async (req, res) => {
  try {
    const asset = await MediaAsset.findOne({
      _id: req.params.assetId,
      tenant_id: req.tenant._id,
    });

    if (!asset) {
      return apiResponse(res, {
        status: 404,
        success: false,
        error: 'Media asset not found',
      });
    }

    const absolutePath = path.join(STORAGE_ROOT, asset.relative_path);
    await fs.unlink(absolutePath).catch(() => null);
    await asset.deleteOne();

    return apiResponse(res, {
      data: {
        message: 'Media asset deleted',
      },
    });
  } catch (error) {
    console.error('[Media Route] Failed to delete asset', error);
    return apiResponse(res, {
      status: 500,
      success: false,
      error: 'Failed to delete media asset',
    });
  }
});

module.exports = router;
