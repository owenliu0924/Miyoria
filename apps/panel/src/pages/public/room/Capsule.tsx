import { ArrowUp, History, Plus, Volume2, VolumeX } from "lucide-react";
import { type ClipboardEvent, type FormEvent, type KeyboardEvent, type RefObject, useId } from "react";

export interface VoiceKeyView {
  usable: boolean;
  pressed: boolean;
  reason: string | null;
  label: string;
}

/**
 * The one long capsule: a quiet + for pictures and files, the words, 紀錄 (desktop), her voice and
 * send. Enter sends; Enter in an empty capsule steps her reply on. No microphone in this version
 * (docs/design/her-room.md §1).
 */
export function Capsule({
  text,
  onText,
  hint,
  inputRef,
  logRef,
  onSubmit,
  onEmptyEnter,
  onAttach,
  onPasteFiles,
  onOpenLog,
  voice,
  onVoice,
  sendBlocked,
}: {
  text: string;
  onText: (text: string) => void;
  hint: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  logRef: RefObject<HTMLButtonElement | null>;
  onSubmit: () => void;
  onEmptyEnter: () => void;
  onAttach: () => void;
  onPasteFiles: (files: File[]) => void;
  onOpenLog: () => void;
  voice: VoiceKeyView;
  onVoice: () => void;
  /** Why send would not go now (files still going up), else `null`. */
  sendBlocked: string | null;
}) {
  const id = useId();
  const reasonId = `${id}-voice`;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (sendBlocked === null) onSubmit();
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey) return;
    e.preventDefault();
    if (text.trim() === "") onEmptyEnter();
    else if (sendBlocked === null) onSubmit();
  };
  const paste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length === 0) return;
    e.preventDefault();
    onPasteFiles(files);
  };
  return (
    <form className="hr-capsule" onSubmit={submit}>
      <button type="button" className="hr-ib" aria-label="附加圖片或檔案" title="附加圖片或檔案" onClick={onAttach}>
        <Plus className="hr-i" aria-hidden="true" />
      </button>
      <label htmlFor={`${id}-say`} className="hr-sr">
        跟她說的話
      </label>
      <textarea
        id={`${id}-say`}
        ref={inputRef}
        rows={1}
        value={text}
        placeholder={hint}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={key}
        onPaste={paste}
        enterKeyHint="send"
      />
      <button
        type="button"
        ref={logRef}
        className="hr-ib hr-log-btn"
        aria-label="紀錄"
        aria-haspopup="dialog"
        title="紀錄(PageUp)"
        onClick={onOpenLog}
      >
        <History className="hr-i" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="hr-ib"
        aria-label={voice.label}
        aria-pressed={voice.usable ? voice.pressed : false}
        aria-disabled={voice.usable ? undefined : true}
        aria-describedby={voice.reason ? reasonId : undefined}
        title={voice.reason ?? `${voice.label}:${voice.pressed ? "開" : "關"}`}
        onClick={() => {
          if (voice.usable) onVoice();
        }}
      >
        {voice.usable && voice.pressed ? <Volume2 className="hr-i" aria-hidden="true" /> : <VolumeX className="hr-i" aria-hidden="true" />}
      </button>
      {voice.reason && (
        <span id={reasonId} className="hr-sr">
          {voice.reason}
        </span>
      )}
      <button
        type="submit"
        className="hr-ib hr-send"
        aria-label="送出"
        title={sendBlocked ?? "送出"}
        aria-disabled={sendBlocked !== null ? true : undefined}
      >
        <ArrowUp className="hr-i" aria-hidden="true" />
      </button>
    </form>
  );
}
