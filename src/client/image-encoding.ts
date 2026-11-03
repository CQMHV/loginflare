import { ApiError } from './api';
import { maximumImageBytes } from '../shared/image-limits';

export async function encodeWebP(canvas: HTMLCanvasElement): Promise<Blob> {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
    if (!blob) throw new ApiError('IMAGE_ENCODING_FAILED', 400);
    if (blob.type !== 'image/webp') throw new ApiError('IMAGE_WEBP_UNAVAILABLE', 400);
    if (blob.size > maximumImageBytes) throw new ApiError('IMAGE_UPLOAD_TOO_LARGE', 413);
    return blob;
}
