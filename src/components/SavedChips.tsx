// The "saved connections" chip list shared by the SSH and SFTP/FTP panels:
// a labelled row of clickable chips, each with a small delete button.
export default function SavedChips<T>({
  label,
  icon,
  items,
  chipLabel,
  chipTitle,
  deleteTitle,
  onUse,
  onDelete,
}: {
  /** section label, e.g. "Saved servers" */
  label: string;
  /** emoji shown before each chip label */
  icon: string;
  items: T[];
  chipLabel: (item: T) => string;
  /** optional tooltip (defaults to the chip label) */
  chipTitle?: (item: T) => string;
  deleteTitle: string;
  onUse: (item: T) => void;
  /** the caller wraps its own confirm dialog around the actual delete */
  onDelete: (item: T) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="rmt-saved">
      <label>{label}</label>
      <div className="rmt-saved-list">
        {items.map((s, i) => (
          <span key={i} className="rmt-chip-wrap">
            <button className="rmt-chip" onClick={() => onUse(s)} title={(chipTitle ?? chipLabel)(s)}>
              {icon} {chipLabel(s)}
            </button>
            <button className="rmt-chip-del" title={deleteTitle} onClick={() => onDelete(s)}>
              ✕
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
