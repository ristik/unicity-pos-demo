export type SaveReturnBackup = (content: string) => Promise<void>;

interface BackupFile {
  createWritable(): Promise<{
    write(content: string): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
}

interface BackupPicker {
  showSaveFilePicker?(options: { suggestedName: string }): Promise<BackupFile>;
}

/** Call from the click handler before any network await so the browser can use its user gesture. */
export async function chooseReturnBackup(picker: BackupPicker): Promise<SaveReturnBackup> {
  if (!picker.showSaveFilePicker) throw new Error('Use a browser with Save File support to back up and burn this return.');
  let file: BackupFile;
  try {
    file = await picker.showSaveFilePicker({ suggestedName: 'nb2-return.private.json' });
  } catch {
    throw new Error('Private return backup selection canceled or unavailable. Run Burn again to choose a file.');
  }
  return async (content) => {
    const writer = await file.createWritable().catch(() => undefined);
    if (!writer) throw new Error('Could not open the private return backup for writing.');
    try {
      await writer.write(content);
      await writer.close();
    } catch {
      await writer.abort().catch(() => undefined);
      throw new Error('Could not save the private return backup. Run Burn again to save the same request.');
    }
  };
}
