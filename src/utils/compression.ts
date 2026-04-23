import { deflateSync } from "fflate";
import { COMPRESSION_THRESHOLD } from "../constants";
import { CompressionType } from "../types"

export const compressionTypeList = [CompressionType.Zstd, CompressionType.Brotli, CompressionType.Deflate, CompressionType.DeflateRaw, CompressionType.Gzip];

export function getSupportedCompressionTypes() {
    if (typeof CompressionStream === "undefined") return [CompressionType.None];

    return compressionTypeList.filter(format => {
        try {
            new CompressionStream(format as CompressionFormat);
            return true;
        } catch {
            return false;
        }
    });
}

export function negotiateSupportedCompressionType(peerSupportedTypes: CompressionType[]) {
    const mySupportedTypes = getSupportedCompressionTypes();

    const negotiatedType = mySupportedTypes.find(myType => peerSupportedTypes.includes(myType));

    return negotiatedType ?? CompressionType.None;
}

export async function isCompressionRequired(file: File, compressionType: CompressionType) {
    const mimeType = file.type;
    const fileSize = file.size;
    const ALREADY_COMPRESSED_REGEX = /^(image\/(jpe?g|png|gif|webp|avif|heic|heif|jxl)|video\/.*|audio\/.*|application\/(zip|x-7z-compressed|x-rar-compressed|gzip|x-gzip|x-bzip2|pdf|epub\+zip|vnd\.openxmlformats-officedocument.*))$/i;
    const sliceSize = 64 * 1024;

    if (fileSize < COMPRESSION_THRESHOLD) return false;

    if (ALREADY_COMPRESSED_REGEX.test(mimeType)) return false;

    const offset = Math.floor(file.size / 2);
    const sample = file.slice(offset, offset + sliceSize);
    const sampleSize = sample.size;
    const compressedSampleSize = await getCompressedSize(sample, compressionType);

    // if more or equal to 10%
    if (compressedSampleSize > sampleSize * 0.9) return false;

    return true;
}

async function getCompressedSize(slice: Blob, compressionType: CompressionType) {
    try {
        const buffer = new Uint8Array(await slice.arrayBuffer());

        if (compressionType === CompressionType.None) {
            return deflateSync(buffer).byteLength;
        }

        const cs = new CompressionStream(compressionType as CompressionFormat);
        const writer = cs.writable.getWriter();
        writer.write(buffer);
        writer.close();
        const output = await new Response(cs.readable).arrayBuffer();
        return output.byteLength;
    } catch {
        return Infinity;
    }
}

// Foe test only
export async function testCompression(file: File, compressionType: CompressionType) {
    const offset = Math.floor(file.size / 2);
    const sample = file.slice(offset, offset + 64 * 1024);
    const sampleSize = sample.size;
    const compressedSampleSize = await getCompressedSize(sample, compressionType);
    console.log(((sampleSize - compressedSampleSize) / sampleSize) * 100);
    return (sampleSize / sampleSize) * 100;
}