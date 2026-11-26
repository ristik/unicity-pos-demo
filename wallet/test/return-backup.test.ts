import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseReturnBackup, type DownloadEnv } from '../src/return-backup.js';

const unsaved = /Could not save the private return backup\. Run Burn again to save the same request\./;

function fakeEnv(answer: boolean): DownloadEnv & { downloads: [string, string][]; asked: string[] } {
  const downloads: [string, string][] = [];
  const asked: string[] = [];
  return { downloads, asked, download: (name, content) => { downloads.push([name, content]); }, confirm: (m) => { asked.push(m); return answer; } };
}

test('with the picker, the file is written and nothing is downloaded or asked', async () => {
  const env = fakeEnv(true);
  let written = '';
  const save = await chooseReturnBackup({
    showSaveFilePicker: async ({ suggestedName }) => {
      assert.equal(suggestedName, 'nb2-return.private.json');
      return { createWritable: async () => ({ write: async (c) => { written = c; }, close: async () => undefined, abort: async () => undefined }) };
    },
  }, env);
  await save('secret');
  assert.equal(written, 'secret');
  assert.deepEqual(env.downloads, []);
  assert.deepEqual(env.asked, []);
});

test('without the picker, the content is downloaded and the user confirms it was saved', async () => {
  const env = fakeEnv(true);
  const save = await chooseReturnBackup({}, env);
  assert.deepEqual(env.downloads, [], 'nothing happens until the burn writes the backup');
  await save('{"private":1}');
  assert.deepEqual(env.downloads, [['nb2-return.private.json', '{"private":1}']]);
  assert.equal(env.asked.length, 1);
  assert.match(env.asked[0], /private recovery data for this return and must be kept/);
});

test('without the picker, a declined confirmation refuses so the burn does not proceed', async () => {
  const env = fakeEnv(false);
  const save = await chooseReturnBackup({}, env);
  await assert.rejects(save('x'), unsaved);
  assert.equal(env.downloads.length, 1);
});

test('without the picker, a failing download refuses without asking', async () => {
  const env = fakeEnv(true);
  const save = await chooseReturnBackup({}, { ...env, download: () => { throw new Error('blocked'); } });
  await assert.rejects(save('x'), unsaved);
  assert.deepEqual(env.asked, []);
});
