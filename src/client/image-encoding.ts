import { ApiError } from './api';

export async function encodeWebP(canvas: HTMLCanvasElement, maximumBytes: number): Promise<Blob> {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
    if (!blob || blob.size > maximumBytes) throw new ApiError('IMAGE_ENCODING_FAILED', 400);
    if (blob.type !== 'image/webp') throw new ApiError('IMAGE_WEBP_UNAVAILABLE', 400);
    return blob;
}
