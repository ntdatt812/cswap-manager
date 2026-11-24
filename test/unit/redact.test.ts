import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactLine, redactText, stripAnsi } from '../../src/core/security/redact';

describe('redactText', () => {
  it('redacts emails and UUIDs', () => {
    const text = redactText('Switched to Alice.Smith+x@corp.example.co (org 123e4567-e89b-42d3-a456-426614174000)');
    assert.equal(text, 'Switched to <email> (org <uuid>)');
  });

  it('redacts token-like secrets', () => {
    const text = redactText(
      'token sk-ant-oat01-AbC_dEf-123 auth Bearer abc.def-ghi jwt eyJhbGciOi.eyJzdWIiOiIx.sig opaque ' + 'a'.repeat(48),
    );
    assert.equal(text.includes('sk-ant'), false);
    assert.equal(text.includes('abc.def'), false);
    assert.equal(text.includes('eyJ'), false);
    assert.equal(text.includes('a'.repeat(48)), false);
  });

  it('replaces the home directory with either separator style', () => {
    const home = 'C:\\Users\\SomeUser';
    assert.equal(redactText('C:\\Users\\SomeUser\\.local\\bin\\cswap.exe', { homeDir: home }), '~\\.local\\bin\\cswap.exe');
    assert.equal(redactText('c:/users/someuser/.local/bin/cswap.exe', { homeDir: home }), '~/.local/bin/cswap.exe');
  });

  it('redacts other user profile paths', () => {
    assert.equal(redactText('D:\\x C:\\Users\\other\\file'), 'D:\\x C:\\Users\\<user>\\file');
    assert.equal(redactText('at /home/other/bin'), 'at /home/<user>/bin');
  });

  it('strips ANSI escapes and truncates', () => {
    assert.equal(stripAnsi('\u001b[38;5;250mnotice\u001b[0m'), 'notice');
    assert.equal(redactText('abcdefghij', { maxLength: 5 }), 'abcd…');
  });
});

describe('redactLine', () => {
  const stderr = 'usage: cswap <command>\ncswap: error: unknown account bob@example.com\n\n';

  it('picks the last line for errors and the first for notices', () => {
    assert.equal(redactLine(stderr, 'last'), 'cswap: error: unknown account <email>');
    assert.equal(redactLine(stderr, 'first'), 'usage: cswap <command>');
  });

  it('returns undefined for blank output', () => {
    assert.equal(redactLine(' \n\n', 'first'), undefined);
  });
});
