/**
 * 媒体类型检测：区分图片与视频。
 * 消息里的媒体统一以字符串存储（http(s) URL / data URL / 本地路径），
 * 通过 data URL 的 MIME 或扩展名判断种类。
 */

export type MediaKind = "image" | "video";

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv|mkv|avi)(\?|#|$)/i;

/** 判断媒体字符串是图片还是视频（默认按图片处理）。 */
export function detectMediaKind(src: string): MediaKind {
    if (src.startsWith("data:")) {
        const mime = /^data:([^;,]+)/.exec(src)?.[1] ?? "";
        return mime.startsWith("video/") ? "video" : "image";
    }
    return VIDEO_EXT_RE.test(src) ? "video" : "image";
}

export interface MediaItem {
    src: string;
    kind: MediaKind;
}

/** 把消息里的媒体字符串数组转成带种类的列表（过滤空串）。 */
export function toMediaList(images?: string[]): MediaItem[] {
    return (images ?? [])
        .filter((s) => typeof s === "string" && s.trim())
        .map((src) => ({ src, kind: detectMediaKind(src) }));
}
