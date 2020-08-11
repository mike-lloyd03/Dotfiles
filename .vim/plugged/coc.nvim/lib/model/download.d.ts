import { DownloadOptions } from '../types';
/**
 * Download file from url, with optional untar support.
 *
 * @param {string} url
 * @param {DownloadOptions} options contains dest folder and optional onProgress callback
 */
export default function download(url: string, options: DownloadOptions): Promise<string>;
