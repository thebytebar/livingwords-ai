/**
 * @deprecated Post-training data is now handled in Python.
 * See training/common/dataset.py and the sft/dpo scripts.
 *
 * Legacy stubs only.
 */

export interface SFTExample {
  text?: string;
  prompt?: string;
  completion?: string;
}

export interface PreferenceExample {
  prompt: string;
  chosen: string;
  rejected: string;
}

/** @deprecated */
export async function loadSFTData(_path: string): Promise<SFTExample[]> {
  throw new Error('loadSFTData (JS) removed. Use Python training scripts.');
}

/** @deprecated */
export async function loadPreferenceData(_path: string): Promise<PreferenceExample[]> {
  throw new Error('loadPreferenceData (JS) removed. Use Python training scripts.');
}
