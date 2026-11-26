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

/** The browser pieces of the download fallback, injectable for tests. */
export interface DownloadEnv {
  /** Offer `content` as a file download named `name`. */
  download(name: string, content: string): void;
  confirm(message: string): boolean;
}

const BACKUP_NAME = 'nb2-return.private.json';

const browserDownload: DownloadEnv = {
  download(name, content) {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    // revoke after the browser has started the download
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
  confirm: (message) => window.confirm(message),
};

const CONFIRM_TEXT = `${BACKUP_NAME} was downloaded. It holds the private recovery data for this return and must be kept: `
  + 'without it the return may not be recoverable, and anyone who has it can act on this return. Store it somewhere private and safe.\n\n'
  + 'Press OK only once the file is saved. Cancel stops the burn, and you can run Burn again to save the same request.';

/** Call from the click handler before any network await so the browser can use its user gesture. */
export async function chooseReturnBackup(picker: BackupPicker, env: DownloadEnv = browserDownload): Promise<SaveReturnBackup> {
  if (!picker.showSaveFilePicker) {
    // no Save File picker (Firefox): download the file, and only continue once the user confirms it was saved
    return async (content) => {
      try {
        env.download(BACKUP_NAME, content);
      } catch {
        throw new Error('Could not save the private return backup. Run Burn again to save the same request.');
      }
      if (!env.confirm(CONFIRM_TEXT)) throw new Error('Could not save the private return backup. Run Burn again to save the same request.');
    };
  }
  let file: BackupFile;
  try {
    file = await picker.showSaveFilePicker({ suggestedName: BACKUP_NAME });
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
