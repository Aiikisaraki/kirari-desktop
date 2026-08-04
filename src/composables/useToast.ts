import { ref } from "vue";

export interface ToastItem {
  id: number;
  message: string;
  type: "info" | "success" | "error" | "warning";
}

const toasts = ref<ToastItem[]>([]);
let seq = 0;

function push(message: string, type: ToastItem["type"] = "info", duration = 3000) {
  const id = ++seq;
  toasts.value.push({ id, message, type });
  if (duration > 0) {
    setTimeout(() => dismiss(id), duration);
  }
  return id;
}

function dismiss(id: number) {
  const idx = toasts.value.findIndex((t) => t.id === id);
  if (idx !== -1) toasts.value.splice(idx, 1);
}

export function useToast() {
  return {
    toasts,
    dismiss,
    info: (msg: string, duration?: number) => push(msg, "info", duration),
    success: (msg: string, duration?: number) => push(msg, "success", duration),
    error: (msg: string, duration?: number) => push(msg, "error", duration),
    warning: (msg: string, duration?: number) => push(msg, "warning", duration),
  };
}
