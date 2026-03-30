export const selectedFiles: File[] = [];

export function addFiles(files: File[]) {
  selectedFiles.push(...files);
}

export function removeFile(index: number) {
  selectedFiles.splice(index, 1);
}