import { createHmac } from 'node:crypto';
import { ApiError } from './secure-data.js';

const INDEX_KEY_BYTES = 32;

function decodeIndexKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError(503, 'Student-number uniqueness protection is not configured.');
  }
  const key = Buffer.from(value, 'base64url');
  if (key.length !== INDEX_KEY_BYTES || key.toString('base64url') !== value) {
    key.fill(0);
    throw new ApiError(503, 'Student-number uniqueness protection is not configured.');
  }
  return key;
}

export function createStudentNumberIndex(studentNumber) {
  if (typeof studentNumber !== 'string') {
    throw new ApiError(400, 'Student number must be text.');
  }
  const key = decodeIndexKey(process.env.SECURITRES_STUDENT_NUMBER_HMAC_V1_B64URL);
  try {
    return createHmac('sha256', key)
      .update('securitres:student-number-index:v1\0', 'utf8')
      .update(studentNumber, 'utf8')
      .digest('hex');
  } finally {
    key.fill(0);
  }
}
