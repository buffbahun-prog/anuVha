import { createSHA256, type IHasher } from 'hash-wasm';

export async function calculateFileHash(file: File): Promise<Uint8Array> {
    const hasher: IHasher = await createSHA256();
    hasher.init();

    const reader = file.stream().getReader();

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        hasher.update(value);
    }

    return hasher.digest("binary");
}

export async function verifyFileHash(file: File, fileHash: Uint8Array) {
    const calculatedFileHash = await calculateFileHash(file);

    console.log(calculatedFileHash,fileHash, new Uint8Array(await file.arrayBuffer()));

    if (calculatedFileHash.length !== fileHash.length) {
        return false;
    }

    return calculatedFileHash.every((byte, index) => byte === fileHash[index]);
}