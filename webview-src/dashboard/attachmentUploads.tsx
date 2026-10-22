import { useEffect, useRef, useState } from "preact/hooks";
import { validateChatAttachments, type ChatAttachment } from "../../src/domain/chatAttachments";

export async function readChatAttachmentFiles(files: File[], existing = 0): Promise<ChatAttachment[]> {
  if (files.length + existing > 8) throw new Error("Attach up to 8 files.");
  const added: ChatAttachment[] = [];
  for (const file of files) {
    const image = ["image/png", "image/jpeg", "image/webp"].includes(file.type);
    if (file.size > (image ? 1024 * 1024 : 32 * 1024))
      throw new Error(`${file.name} is too large. Images: 1 MB; text: 32 KB.`);
    if (
      !image &&
      !file.type.startsWith("text/") &&
      !/\.(txt|md|json|csv|ts|tsx|js|jsx|py|html|css|xml|yml|yaml|toml|log|rs|go|java|c|cpp|h|sh|sql)$/i.test(file.name)
    )
      throw new Error(`${file.name} is unsupported. Attach PNG, JPEG, WebP, or a text/code file.`);
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      const timer = window.setTimeout(() => {
        reject(new Error(`Reading ${file.name} timed out. Attach it again.`));
        reader.abort();
      }, 10000);
      reader.onload = () => {
        clearTimeout(timer);
        resolve(typeof reader.result === "string" ? reader.result : "");
      };
      reader.onerror = reader.onabort = () => {
        clearTimeout(timer);
        reject(new Error(`${file.name} could not be read. Attach it again.`));
      };
      if (image) reader.readAsDataURL(file);
      else reader.readAsText(file);
    });
    added.push({
      id: crypto.randomUUID(),
      name: file.name,
      kind: image ? "image" : "text",
      mimeType: image ? file.type : "text/plain",
      data,
      size: file.size
    });
  }
  return validateChatAttachments(added);
}
export function AttachmentIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      aria-hidden="true"
    >
      <path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L12 3m-6 14 9-9" />
    </svg>
  );
}
export function AttachmentPicker({
  files,
  onChange,
  disabled,
  label,
  onReading,
  onFeedback
}: {
  files: ChatAttachment[];
  onChange: (files: ChatAttachment[]) => void;
  disabled: boolean;
  label: string;
  onReading: (value: boolean) => void;
  onFeedback: (message: string, error?: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null),
    pending = useRef(false),
    mounted = useRef(true);
  const current = useRef(files);
  current.current = files;
  const [reading, setReading] = useState(false);
  useEffect(
    () => () => {
      mounted.current = false;
      onReading(false);
    },
    []
  );
  const add = async (selected: File[]) => {
    if (pending.current || disabled || !selected.length) return;
    pending.current = true;
    setReading(true);
    onReading(true);
    try {
      const added = await readChatAttachmentFiles(selected, current.current.length);
      if (!mounted.current) return;
      const next = validateChatAttachments([
        ...current.current,
        ...added.filter(
          (file) => !current.current.some((prior) => prior.name === file.name && prior.data === file.data)
        )
      ]);
      onChange(next);
      onFeedback(`${added.length} ${added.length === 1 ? "file" : "files"} attached.`);
    } catch (error) {
      if (mounted.current) onFeedback((error as Error).message, true);
    } finally {
      pending.current = false;
      if (mounted.current) {
        setReading(false);
        onReading(false);
      }
    }
  };
  return (
    <div class="task-upload-control">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept="image/png,image/jpeg,image/webp,text/*,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.html,.css,.xml,.yml,.yaml,.toml,.log,.rs,.go,.java,.c,.cpp,.h,.sh,.sql"
        aria-label={label}
        onChange={(event) => {
          const picked = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          void add(picked);
        }}
      />
      <button
        type="button"
        class="task-attach-button"
        disabled={disabled || reading}
        onClick={() => input.current?.click()}
        aria-label={label}
        title="PNG, JPEG, WebP, text or code · 1 MB total"
      >
        <AttachmentIcon />
        {reading ? "Reading…" : "Attach"}
      </button>
      {files.length ? (
        <div class="task-upload-list">
          {files.map((file) => (
            <span key={file.id}>
              <span title={`${file.name} · ${file.size} bytes`}>{file.name}</span>
              <button
                type="button"
                disabled={disabled || reading}
                aria-label={`Remove ${file.name}`}
                onClick={() => onChange(files.filter((item) => item.id !== file.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
