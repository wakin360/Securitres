import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const FORMAT_VERSION = 1;
const AES_GCM_ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
// This module encrypts one evidence chunk at a time. 3 MiB leaves margin below
// Vercel's 4.5 MB function request-body limit; GCM ciphertext is the same byte
// length as plaintext because the authentication tag is stored separately.
export const MAX_VALUE_BYTES = 3 * 1024 * 1024;
const MAX_CIPHERTEXT_BASE64URL_LENGTH = Math.ceil(MAX_VALUE_BYTES / 3) * 4;
const CONTEXT_FIELDS = ['environment', 'table', 'rowId', 'field'];
const ENVELOPE_FIELDS = [
  'formatVersion',
  'kekVersion',
  'plaintextType',
  'ciphertext',
  'iv',
  'tag',
  'wrappedDek',
  'dekWrapIv',
  'dekWrapTag',
];

/**
 * Envelope encryption gives each value its own random data-encryption key (DEK).
 * AES-256-GCM encrypts the value with that DEK; a separately configured
 * key-encryption key (KEK) wraps the DEK. The plaintext DEK is used only in
 * memory and is never returned or stored unwrapped.
 *
 * Both AES-GCM operations use a fresh 12-byte random IV and authenticate before
 * decrypted bytes are returned. Data AAD binds the value to its environment,
 * table, row, field, type, and format. Separate wrapping AAD also binds the
 * wrapped DEK to that context, its KEK version, and the wrapping purpose.
 *
 * KEK versions select the server-side SECURITRES_KEK_V<version>_B64URL value.
 * The active version is used for new envelopes; decryption selects the version
 * embedded in the envelope, so older KEKs must remain configured while any
 * live ciphertext or retained backup still depends on them.
 */
export class EncryptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EncryptionError';
    this.code = code;
  }
}

function encryptionError(code, message) {
  return new EncryptionError(code, message);
}

function validateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw encryptionError('INVALID_CONTEXT', 'Encryption context is invalid.');
  }

  const keys = Object.keys(context).sort();
  const expectedKeys = [...CONTEXT_FIELDS].sort();
  if (keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])) {
    throw encryptionError('INVALID_CONTEXT', 'Encryption context is invalid.');
  }

  for (const field of CONTEXT_FIELDS) {
    const value = context[field];
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > 256
        || value.trim() !== value
        || /[\u0000-\u001f\u007f]/.test(value)) {
      throw encryptionError('INVALID_CONTEXT', 'Encryption context is invalid.');
    }
  }

  return {
    environment: context.environment,
    table: context.table,
    rowId: context.rowId,
    field: context.field,
  };
}

function buildAad(purpose, context, plaintextType, kekVersion) {
  const fields = [
    'securitres',
    purpose,
    FORMAT_VERSION,
    context.environment,
    context.table,
    context.rowId,
    context.field,
    plaintextType,
  ];
  if (purpose === 'dek-wrap') fields.push(kekVersion);
  return Buffer.from(JSON.stringify(fields), 'utf8');
}

function parseVersion(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw encryptionError('INVALID_CONFIGURATION', 'Encryption key configuration is invalid.');
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version)) {
    throw encryptionError('INVALID_CONFIGURATION', 'Encryption key configuration is invalid.');
  }
  return version;
}

function decodeBase64Url(value, code, message, expectedLength, allowEmpty = false) {
  if (typeof value !== 'string'
      || (!allowEmpty && value.length === 0)
      || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw encryptionError(code, message);
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value
      || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    decoded.fill(0);
    throw encryptionError(code, message);
  }
  return decoded;
}

function getActiveKekVersion() {
  const configuredVersion = process.env.SECURITRES_KEK_ACTIVE_VERSION;
  if (configuredVersion === undefined) {
    throw encryptionError('MISSING_KEY', 'Active encryption key is not configured.');
  }
  return parseVersion(configuredVersion);
}

function getKek(version, active = false) {
  const keyName = `SECURITRES_KEK_V${version}_B64URL`;
  const configuredKey = process.env[keyName];
  if (configuredKey === undefined || configuredKey === '') {
    throw encryptionError(
      active ? 'MISSING_KEY' : 'UNKNOWN_KEY_VERSION',
      active
        ? 'Active encryption key is not configured.'
        : 'Required encryption key version is unavailable.',
    );
  }
  return decodeBase64Url(
    configuredKey,
    'INVALID_CONFIGURATION',
    'Encryption key configuration is invalid.',
    KEY_BYTES,
  );
}

function secureRandomBytes(length) {
  try {
    return randomBytes(length);
  } catch {
    throw encryptionError('RANDOM_GENERATION_FAILED', 'Cryptographic randomness is unavailable.');
  }
}

function getPlaintextMetadata(value) {
  if (typeof value === 'string') {
    return { byteLength: Buffer.byteLength(value, 'utf8'), plaintextType: 'string' };
  }
  if (Buffer.isBuffer(value)) {
    return { byteLength: value.byteLength, plaintextType: 'buffer' };
  }
  if (value instanceof Uint8Array) {
    return { byteLength: value.byteLength, plaintextType: 'uint8array' };
  }
  throw encryptionError('INVALID_VALUE', 'Only strings, Buffers, and Uint8Arrays can be encrypted.');
}

function copyPlaintextBytes(value, plaintextType) {
  if (plaintextType === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(value);
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw encryptionError('INVALID_ENVELOPE', 'Encrypted value is invalid.');
  }

  const keys = Object.keys(envelope).sort();
  const expectedKeys = [...ENVELOPE_FIELDS].sort();
  if (keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])) {
    throw encryptionError('INVALID_ENVELOPE', 'Encrypted value is invalid.');
  }
  if (!Number.isSafeInteger(envelope.formatVersion) || envelope.formatVersion < 1) {
    throw encryptionError('INVALID_ENVELOPE', 'Encrypted value is invalid.');
  }
  if (envelope.formatVersion !== FORMAT_VERSION) {
    throw encryptionError('UNSUPPORTED_FORMAT', 'Encrypted data format version is not supported.');
  }
  if (!Number.isSafeInteger(envelope.kekVersion) || envelope.kekVersion < 1) {
    throw encryptionError('INVALID_ENVELOPE', 'Encrypted value is invalid.');
  }
  if (!['string', 'buffer', 'uint8array'].includes(envelope.plaintextType)) {
    throw encryptionError('INVALID_ENVELOPE', 'Encrypted value is invalid.');
  }
  if (typeof envelope.ciphertext === 'string'
      && envelope.ciphertext.length > MAX_CIPHERTEXT_BASE64URL_LENGTH) {
    throw encryptionError('VALUE_TOO_LARGE', 'Encrypted value exceeds the supported size limit.');
  }
  const encodedFieldLengths = {
    iv: 16,
    dekWrapIv: 16,
    tag: 22,
    dekWrapTag: 22,
    wrappedDek: 43,
  };
  for (const [field, expectedLength] of Object.entries(encodedFieldLengths)) {
    if (typeof envelope[field] !== 'string' || envelope[field].length !== expectedLength) {
      throw encryptionError('INVALID_ENVELOPE', 'Encrypted value is invalid.');
    }
  }

  const binary = {
    ciphertext: decodeBase64Url(
      envelope.ciphertext,
      'INVALID_ENVELOPE',
      'Encrypted value is invalid.',
      undefined,
      true,
    ),
    iv: decodeBase64Url(
      envelope.iv,
      'INVALID_ENVELOPE',
      'Encrypted value is invalid.',
      IV_BYTES,
    ),
    tag: decodeBase64Url(
      envelope.tag,
      'INVALID_ENVELOPE',
      'Encrypted value is invalid.',
      TAG_BYTES,
    ),
    wrappedDek: decodeBase64Url(
      envelope.wrappedDek,
      'INVALID_ENVELOPE',
      'Encrypted value is invalid.',
      KEY_BYTES,
    ),
    dekWrapIv: decodeBase64Url(
      envelope.dekWrapIv,
      'INVALID_ENVELOPE',
      'Encrypted value is invalid.',
      IV_BYTES,
    ),
    dekWrapTag: decodeBase64Url(
      envelope.dekWrapTag,
      'INVALID_ENVELOPE',
      'Encrypted value is invalid.',
      TAG_BYTES,
    ),
  };
  if (binary.ciphertext.length > MAX_VALUE_BYTES) {
    binary.ciphertext.fill(0);
    throw encryptionError('VALUE_TOO_LARGE', 'Encrypted value exceeds the supported size limit.');
  }

  return { ...binary, kekVersion: envelope.kekVersion, plaintextType: envelope.plaintextType };
}

function authenticateDecrypt({ algorithmKey, iv, tag, aad, ciphertext }) {
  let firstChunk;
  let finalChunk;
  let plaintext;
  try {
    const decipher = createDecipheriv(AES_GCM_ALGORITHM, algorithmKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    firstChunk = decipher.update(ciphertext);
    finalChunk = decipher.final();
    plaintext = Buffer.concat([firstChunk, finalChunk]);
    return plaintext;
  } catch {
    plaintext?.fill(0);
    throw encryptionError('AUTHENTICATION_FAILED', 'Encrypted data could not be authenticated.');
  } finally {
    firstChunk?.fill(0);
    finalChunk?.fill(0);
    aad.fill(0);
  }
}

function encryptBytes(plaintext, key, iv, aad) {
  let updateBuffer;
  let finalBuffer;
  try {
    const cipher = createCipheriv(AES_GCM_ALGORITHM, key, iv);
    cipher.setAAD(aad);
    updateBuffer = cipher.update(plaintext);
    finalBuffer = cipher.final();
    const ciphertext = Buffer.concat([updateBuffer, finalBuffer]);
    return { ciphertext, tag: cipher.getAuthTag() };
  } catch {
    throw encryptionError('ENCRYPTION_FAILED', 'Encryption failed.');
  } finally {
    updateBuffer?.fill(0);
    finalBuffer?.fill(0);
    plaintext.fill(0);
    aad.fill(0);
  }
}

/**
 * Encrypt a string, Buffer, or Uint8Array using a unique random DEK.
 * The returned envelope contains no plaintext or unwrapped key material.
 */
export function encryptValue(value, suppliedContext) {
  const context = validateContext(suppliedContext);
  const { byteLength, plaintextType } = getPlaintextMetadata(value);
  if (byteLength > MAX_VALUE_BYTES) {
    throw encryptionError('VALUE_TOO_LARGE', 'Value exceeds the supported size limit.');
  }
  const kekVersion = getActiveKekVersion();
  const kek = getKek(kekVersion, true);
  let plaintext;
  let dek;
  let iv;
  let dekWrapIv;

  try {
    plaintext = copyPlaintextBytes(value, plaintextType);
    dek = secureRandomBytes(KEY_BYTES);
    iv = secureRandomBytes(IV_BYTES);
    dekWrapIv = secureRandomBytes(IV_BYTES);
    const encryptedData = encryptBytes(
      plaintext,
      dek,
      iv,
      buildAad('data', context, plaintextType),
    );
    const wrappedDek = encryptBytes(
      dek,
      kek,
      dekWrapIv,
      buildAad('dek-wrap', context, plaintextType, kekVersion),
    );

    return {
      formatVersion: FORMAT_VERSION,
      kekVersion,
      plaintextType,
      ciphertext: encryptedData.ciphertext.toString('base64url'),
      iv: iv.toString('base64url'),
      tag: encryptedData.tag.toString('base64url'),
      wrappedDek: wrappedDek.ciphertext.toString('base64url'),
      dekWrapIv: dekWrapIv.toString('base64url'),
      dekWrapTag: wrappedDek.tag.toString('base64url'),
    };
  } finally {
    plaintext?.fill(0);
    dek?.fill(0);
    kek.fill(0);
    iv?.fill(0);
    dekWrapIv?.fill(0);
  }
}

/**
 * Authenticate the wrapped DEK and data before returning plaintext.
 * Strings return as strings; Buffers and Uint8Arrays retain their types.
 */
export function decryptValue(envelope, suppliedContext) {
  const context = validateContext(suppliedContext);
  const validated = validateEnvelope(envelope);
  const kek = getKek(validated.kekVersion);
  let dek;
  let plaintext;

  try {
    dek = authenticateDecrypt({
      algorithmKey: kek,
      iv: validated.dekWrapIv,
      tag: validated.dekWrapTag,
      aad: buildAad('dek-wrap', context, validated.plaintextType, validated.kekVersion),
      ciphertext: validated.wrappedDek,
    });
    if (dek.length !== KEY_BYTES) {
      dek.fill(0);
      throw encryptionError('INVALID_ENVELOPE', 'Encrypted value is invalid.');
    }

    plaintext = authenticateDecrypt({
      algorithmKey: dek,
      iv: validated.iv,
      tag: validated.tag,
      aad: buildAad('data', context, validated.plaintextType),
      ciphertext: validated.ciphertext,
    });

    if (validated.plaintextType === 'buffer') return Buffer.from(plaintext);
    if (validated.plaintextType === 'uint8array') return new Uint8Array(plaintext);
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch (error) {
    if (error instanceof EncryptionError) throw error;
    throw encryptionError('INVALID_PLAINTEXT', 'Decrypted value has an invalid encoding.');
  } finally {
    dek?.fill(0);
    kek.fill(0);
    plaintext?.fill(0);
    for (const field of ['ciphertext', 'iv', 'tag', 'wrappedDek', 'dekWrapIv', 'dekWrapTag']) {
      validated[field].fill(0);
    }
  }
}
