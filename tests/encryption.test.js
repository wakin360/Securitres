import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  decryptValue,
  encryptValue,
  EncryptionError,
  MAX_VALUE_BYTES,
} from '../api/_lib/encryption.js';

const context = {
  environment: 'test',
  table: 'profiles',
  rowId: '00000000-0000-4000-8000-000000000001',
  field: 'full_name',
};
const keyVariableNames = [
  'SECURITRES_KEK_ACTIVE_VERSION',
  'SECURITRES_KEK_V1_B64URL',
  'SECURITRES_KEK_V2_B64URL',
];

function testKeys() {
  return {
    v1: randomBytes(32).toString('base64url'),
    v2: randomBytes(32).toString('base64url'),
  };
}

async function withKeys(keys, activeVersion, run) {
  const previous = new Map(keyVariableNames.map((name) => [name, process.env[name]]));
  process.env.SECURITRES_KEK_ACTIVE_VERSION = String(activeVersion);
  process.env.SECURITRES_KEK_V1_B64URL = keys.v1;
  process.env.SECURITRES_KEK_V2_B64URL = keys.v2;
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function replaceByte(encoded) {
  const bytes = Buffer.from(encoded, 'base64url');
  assert.ok(bytes.length > 0);
  bytes[0] ^= 1;
  return bytes.toString('base64url');
}

function expectEncryptionError(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof EncryptionError);
    assert.equal(error.code, code);
    for (const name of keyVariableNames) {
      const configuredValue = process.env[name];
      if (configuredValue) assert.ok(!error.message.includes(configuredValue));
    }
    return true;
  });
}

function unwrapDekForTest(envelope, suppliedContext, kekBytes) {
  const aad = Buffer.from(JSON.stringify([
    'securitres',
    'dek-wrap',
    envelope.formatVersion,
    suppliedContext.environment,
    suppliedContext.table,
    suppliedContext.rowId,
    suppliedContext.field,
    envelope.plaintextType,
    envelope.kekVersion,
  ]));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    kekBytes,
    Buffer.from(envelope.dekWrapIv, 'base64url'),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.dekWrapTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.wrappedDek, 'base64url')),
    decipher.final(),
  ]);
}

function makeAuthenticatedStringEnvelope(plaintextBytes, suppliedContext, kekBytes, kekVersion) {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const dekWrapIv = randomBytes(12);
  const dataAad = Buffer.from(JSON.stringify([
    'securitres',
    'data',
    1,
    suppliedContext.environment,
    suppliedContext.table,
    suppliedContext.rowId,
    suppliedContext.field,
    'string',
  ]));
  const wrapAad = Buffer.from(JSON.stringify([
    'securitres',
    'dek-wrap',
    1,
    suppliedContext.environment,
    suppliedContext.table,
    suppliedContext.rowId,
    suppliedContext.field,
    'string',
    kekVersion,
  ]));

  try {
    const dataCipher = createCipheriv('aes-256-gcm', dek, iv);
    dataCipher.setAAD(dataAad);
    const ciphertext = Buffer.concat([
      dataCipher.update(plaintextBytes),
      dataCipher.final(),
    ]);

    const wrapCipher = createCipheriv('aes-256-gcm', kekBytes, dekWrapIv);
    wrapCipher.setAAD(wrapAad);
    const wrappedDek = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);

    return {
      formatVersion: 1,
      kekVersion,
      plaintextType: 'string',
      ciphertext: ciphertext.toString('base64url'),
      iv: iv.toString('base64url'),
      tag: dataCipher.getAuthTag().toString('base64url'),
      wrappedDek: wrappedDek.toString('base64url'),
      dekWrapIv: dekWrapIv.toString('base64url'),
      dekWrapTag: wrapCipher.getAuthTag().toString('base64url'),
    };
  } finally {
    plaintextBytes.fill(0);
    dek.fill(0);
    iv.fill(0);
    dekWrapIv.fill(0);
    dataAad.fill(0);
    wrapAad.fill(0);
  }
}

test('AES-256-GCM envelope encryption', async (t) => {
  await t.test('round-trips a student name', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('Test Student', context);
      assert.equal(decryptValue(envelope, context), 'Test Student');
    });
  });

  await t.test('round-trips a student number', async () => {
    await withKeys(testKeys(), 1, async () => {
      const studentNumberContext = { ...context, field: 'student_number' };
      const envelope = encryptValue('STUDENT-0001', studentNumberContext);
      assert.equal(decryptValue(envelope, studentNumberContext), 'STUDENT-0001');
    });
  });

  await t.test('round-trips arbitrary Buffer bytes without UTF-8 conversion', async () => {
    await withKeys(testKeys(), 1, async () => {
      const value = Buffer.from([0, 255, 195, 40, 128, 10]);
      const envelope = encryptValue(value, context);
      const result = decryptValue(envelope, context);
      assert.ok(Buffer.isBuffer(result));
      assert.deepEqual(result, value);
    });
  });

  await t.test('round-trips Uint8Array while preserving its type', async () => {
    await withKeys(testKeys(), 1, async () => {
      const value = new Uint8Array([0, 255, 16, 128]);
      const envelope = encryptValue(value, context);
      const result = decryptValue(envelope, context);
      assert.ok(result instanceof Uint8Array);
      assert.deepEqual(result, value);
    });
  });

  await t.test('round-trips an empty string', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('', context);
      assert.equal(decryptValue(envelope, context), '');
    });
  });

  await t.test('uses the supplied AAD context', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('value', context);
      assert.equal(decryptValue(envelope, context), 'value');
    });
  });

  await t.test('round-trips unusual Unicode context values', async () => {
    await withKeys(testKeys(), 1, async () => {
      const unicodeContext = {
        environment: 'preview-🌏',
        table: 'profiles-用户',
        rowId: 'record-𐐷-e\u0301',
        field: '名🧑‍🎓',
      };
      const envelope = encryptValue('Unicode context value', unicodeContext);
      assert.equal(decryptValue(envelope, unicodeContext), 'Unicode context value');
    });
  });

  await t.test('decrypts older envelopes while the older KEK remains configured', async () => {
    const keys = testKeys();
    await withKeys(keys, 1, async () => {
      const envelope = encryptValue('old-key value', context);
      await withKeys(keys, 2, async () => {
        assert.equal(decryptValue(envelope, context), 'old-key value');
        assert.equal(encryptValue('new-key value', context).kekVersion, 2);
      });
    });
  });

  await t.test('uses fresh IVs and distinct DEKs for identical plaintext', async () => {
    await withKeys(testKeys(), 1, async () => {
      const first = encryptValue('same value', context);
      const second = encryptValue('same value', context);
      assert.notEqual(first.iv, second.iv);
      assert.notEqual(first.dekWrapIv, second.dekWrapIv);
      assert.notEqual(first.wrappedDek, second.wrappedDek);

      const kek = Buffer.from(process.env.SECURITRES_KEK_V1_B64URL, 'base64url');
      const firstDek = unwrapDekForTest(first, context, kek);
      const secondDek = unwrapDekForTest(second, context, kek);
      try {
        assert.notDeepEqual(firstDek, secondDek);
      } finally {
        kek.fill(0);
        firstDek.fill(0);
        secondDek.fill(0);
      }
    });
  });

  await t.test('rejects modified ciphertext without returning plaintext', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      envelope.ciphertext = replaceByte(envelope.ciphertext);
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'AUTHENTICATION_FAILED',
      );
    });
  });

  await t.test('rejects a modified data authentication tag', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      envelope.tag = replaceByte(envelope.tag);
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'AUTHENTICATION_FAILED',
      );
    });
  });

  await t.test('rejects a modified wrapped DEK', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      envelope.wrappedDek = replaceByte(envelope.wrappedDek);
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'AUTHENTICATION_FAILED',
      );
    });
  });

  await t.test('rejects a modified DEK wrapping tag', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      envelope.dekWrapTag = replaceByte(envelope.dekWrapTag);
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'AUTHENTICATION_FAILED',
      );
    });
  });

  await t.test('rejects a modified data IV', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      envelope.iv = replaceByte(envelope.iv);
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'AUTHENTICATION_FAILED',
      );
    });
  });

  await t.test('rejects a modified wrapping IV', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      envelope.dekWrapIv = replaceByte(envelope.dekWrapIv);
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'AUTHENTICATION_FAILED',
      );
    });
  });

  for (const field of ['environment', 'table', 'rowId', 'field']) {
    await t.test(`rejects a changed ${field} context`, async () => {
      await withKeys(testKeys(), 1, async () => {
        const envelope = encryptValue('protected value', context);
        const wrongContext = { ...context, [field]: `${context[field]}-other` };
        await expectEncryptionError(
          Promise.resolve().then(() => decryptValue(envelope, wrongContext)),
          'AUTHENTICATION_FAILED',
        );
      });
    });
  }

  await t.test('rejects an unsupported envelope format version', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      envelope.formatVersion = 2;
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'UNSUPPORTED_FORMAT',
      );
    });
  });

  await t.test('rejects encryption when the active KEK is missing', async () => {
    await withKeys(testKeys(), 1, async () => {
      delete process.env.SECURITRES_KEK_V1_B64URL;
      await expectEncryptionError(
        Promise.resolve().then(() => encryptValue('value', context)),
        'MISSING_KEY',
      );
    });
  });

  await t.test('rejects malformed KEK configuration', async () => {
    await withKeys(testKeys(), 1, async () => {
      process.env.SECURITRES_KEK_V1_B64URL = 'invalid*base64url';
      await expectEncryptionError(
        Promise.resolve().then(() => encryptValue('value', context)),
        'INVALID_CONFIGURATION',
      );
    });
  });

  await t.test('rejects an incorrectly sized KEK', async () => {
    await withKeys(testKeys(), 1, async () => {
      process.env.SECURITRES_KEK_V1_B64URL = randomBytes(31).toString('base64url');
      await expectEncryptionError(
        Promise.resolve().then(() => encryptValue('value', context)),
        'INVALID_CONFIGURATION',
      );
    });
  });

  await t.test('rejects non-canonical or invalid base64url envelope fields', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      envelope.ciphertext = 'AA=';
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'INVALID_ENVELOPE',
      );
    });
  });

  await t.test('rejects missing envelope properties', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      delete envelope.tag;
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'INVALID_ENVELOPE',
      );
    });
  });

  await t.test('rejects oversized encoded metadata before decoding', async (subtest) => {
    const oversizedFields = [
      ['iv', 16],
      ['dekWrapIv', 16],
      ['tag', 22],
      ['dekWrapTag', 22],
      ['wrappedDek', 43],
    ];
    for (const [field, expectedLength] of oversizedFields) {
      await subtest.test(field, async () => {
        await withKeys(testKeys(), 1, async () => {
          const envelope = encryptValue('protected value', context);
          envelope[field] = 'A'.repeat(expectedLength + 1);
          await expectEncryptionError(
            Promise.resolve().then(() => decryptValue(envelope, context)),
            'INVALID_ENVELOPE',
          );
        });
      });
    }
  });

  await t.test('rejects unexpected envelope properties', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      envelope.unexpected = 'value';
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'INVALID_ENVELOPE',
      );
    });
  });

  await t.test('rejects unsupported plaintext input types', async () => {
    await withKeys(testKeys(), 1, async () => {
      for (const value of [null, 42, {}, new DataView(new ArrayBuffer(4))]) {
        await expectEncryptionError(
          Promise.resolve().then(() => encryptValue(value, context)),
          'INVALID_VALUE',
        );
      }
    });
  });

  await t.test('rejects authenticated string plaintext with invalid UTF-8', async () => {
    await withKeys(testKeys(), 1, async () => {
      const kek = Buffer.from(process.env.SECURITRES_KEK_V1_B64URL, 'base64url');
      try {
        const envelope = makeAuthenticatedStringEnvelope(
          Buffer.from([0xc3, 0x28]),
          context,
          kek,
          1,
        );
        await expectEncryptionError(
          Promise.resolve().then(() => decryptValue(envelope, context)),
          'INVALID_PLAINTEXT',
        );
      } finally {
        kek.fill(0);
      }
    });
  });

  await t.test('rejects oversized encryption input before requiring a KEK', async () => {
    await withKeys(testKeys(), 1, async () => {
      delete process.env.SECURITRES_KEK_V1_B64URL;
      const oversized = Buffer.alloc(MAX_VALUE_BYTES + 1);
      await expectEncryptionError(
        Promise.resolve().then(() => encryptValue(oversized, context)),
        'VALUE_TOO_LARGE',
      );
      oversized.fill(0);
    });
  });

  await t.test('rejects oversized ciphertext before decoding or decrypting it', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      const oversizedEncodedLength = Math.ceil((MAX_VALUE_BYTES + 1) / 3) * 4;
      envelope.ciphertext = 'A'.repeat(oversizedEncodedLength);
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'VALUE_TOO_LARGE',
      );
    });
  });

  await t.test('rejects incorrect IV and authentication-tag lengths', async (subtest) => {
    const mutations = [
      ['data IV', 'iv', Buffer.alloc(11).toString('base64url')],
      ['data tag', 'tag', Buffer.alloc(15).toString('base64url')],
      ['wrapping IV', 'dekWrapIv', Buffer.alloc(13).toString('base64url')],
      ['wrapping tag', 'dekWrapTag', Buffer.alloc(17).toString('base64url')],
      ['wrapped DEK', 'wrappedDek', Buffer.alloc(31).toString('base64url')],
    ];
    for (const [label, field, value] of mutations) {
      await subtest.test(label, async () => {
        await withKeys(testKeys(), 1, async () => {
          const envelope = encryptValue('protected value', context);
          envelope[field] = value;
          await expectEncryptionError(
            Promise.resolve().then(() => decryptValue(envelope, context)),
            'INVALID_ENVELOPE',
          );
        });
      });
    }
  });

  await t.test('rejects missing and incomplete AAD contexts', async () => {
    await withKeys(testKeys(), 1, async () => {
      await expectEncryptionError(
        Promise.resolve().then(() => encryptValue('value', null)),
        'INVALID_CONTEXT',
      );
      await expectEncryptionError(
        Promise.resolve().then(() => encryptValue('value', { environment: 'test' })),
        'INVALID_CONTEXT',
      );
    });
  });

  await t.test('rejects an unavailable KEK version', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      envelope.kekVersion = 99;
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'UNKNOWN_KEY_VERSION',
      );
    });
  });

  await t.test('authenticates the KEK version in wrapping AAD', async () => {
    await withKeys(testKeys(), 1, async () => {
      const envelope = encryptValue('protected value', context);
      envelope.kekVersion = 2;
      await expectEncryptionError(
        Promise.resolve().then(() => decryptValue(envelope, context)),
        'AUTHENTICATION_FAILED',
      );
    });
  });

  await t.test('rejects an invalid active KEK version', async () => {
    await withKeys(testKeys(), 1, async () => {
      process.env.SECURITRES_KEK_ACTIVE_VERSION = '01';
      await expectEncryptionError(
        Promise.resolve().then(() => encryptValue('value', context)),
        'INVALID_CONFIGURATION',
      );
    });
  });
});
