import { useState, type FormEvent } from "react";

/**
 * Approve with the two digits Dormouse shows (docs/specs/hosted.md -> "Burrow
 * enrollment"). This page cannot check them: the relay compares them when the
 * computer polls, and an approval with other digits redeems nothing.
 */
export function ConfirmDigits({
  busy,
  onApprove,
}: {
  busy: string;
  onApprove: (confirmDigits: string) => void;
}) {
  const [digits, setDigits] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (digits.length === 2 && !busy) onApprove(digits);
  }
  return (
    <form onSubmit={submit}>
      <label htmlFor="confirm-digits">
        Type the two digits Dormouse is showing
      </label>
      <input
        id="confirm-digits"
        className="confirm-digits"
        inputMode="numeric"
        autoComplete="off"
        pattern="[0-9]{2}"
        minLength={2}
        maxLength={2}
        required
        autoFocus
        value={digits}
        disabled={!!busy}
        onChange={(event) => setDigits(event.target.value.replace(/\D/g, ""))}
      />
      <p className="help">
        Only the computer that sent you here shows them. If they are not its
        digits, nothing is approved, and that code cannot be approved again.
      </p>
      <button className="primary" disabled={!!busy || digits.length !== 2} type="submit">
        {busy === "approve" ? "Approving…" : "Approve"}
      </button>
    </form>
  );
}
