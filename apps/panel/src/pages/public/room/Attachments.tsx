import { FileText, Paperclip, X } from "lucide-react";
import type { Attached } from "./attach-limits";
import { sizeText } from "./room-text";

/** The files attached to the next line: small chips above the capsule, each with its ×. */
export function Attachments({ items, onRemove }: { items: readonly Attached[]; onRemove: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <ul className="hr-attach" aria-label="附加的檔案">
      {items.map((a) => {
        const uploading = a.upload === null && a.error === null;
        const status = a.error ?? (uploading ? `${Math.round(a.progress * 100)}%` : sizeText(a.size));
        return (
          <li key={a.key} className="hr-chip" data-failed={a.error !== null ? "" : undefined} title={a.error ?? a.name}>
            {a.preview ? (
              <img src={a.preview} alt="" />
            ) : (
              <span className="hr-fi" aria-hidden="true">
                <FileText />
              </span>
            )}
            <span className="hr-nm">{a.name}</span>
            <span className="hr-sz">{a.error ? "沒傳上去" : status}</span>
            {uploading && (
              <span
                className="hr-progress"
                style={{ width: `${Math.round(a.progress * 100)}%` }}
                role="progressbar"
                aria-label={`${a.name} 上傳中`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(a.progress * 100)}
              />
            )}
            <button type="button" className="hr-ib hr-x" aria-label={`拿掉 ${a.name}`} title="拿掉" onClick={() => onRemove(a.key)}>
              <X className="hr-i" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** While files are dragged over the page: a quiet dashed ring and one line. */
export function DropHint() {
  return (
    <div className="hr-drop" aria-hidden="true">
      <span>
        <Paperclip className="hr-i" aria-hidden="true" />
        放開就附加給她
      </span>
    </div>
  );
}
