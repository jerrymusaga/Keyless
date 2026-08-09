"use client";

import { useState } from "react";
import { useKeyless } from "./KeylessProvider";
import { Button, Card, Copy, Notice } from "./ui";
import { addr, explorerAddress } from "@/lib/keyless";

/**
 * Backup and recovery for the *control key* — the browser-held key that edits your accounts' rules.
 * This is the only exportable key in Keyless: the XRP keys live in the enclave and can never be
 * revealed. Losing the control key means losing the ability to change rules (funds stay governed by
 * whatever rule is set), so backing it up is worth a click.
 */
export function ControlKey() {
  const { address, exportSecret, importKey, forget } = useKeyless();
  const [revealed, setRevealed] = useState<{ secret: string; isPhrase: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const [pkInput, setPkInput] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const reveal = () => setRevealed(exportSecret());
  const doImport = () => {
    setErr(null);
    try {
      importKey(pkInput);
      setImporting(false);
      setPkInput("");
    } catch {
      setErr("That doesn't look like a valid recovery phrase or key.");
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium text-mist-100">Your control key</h2>
          <p className="mt-1 text-[13px] text-mist-400">
            Held in this browser. It edits your rules — it can never move your XRP directly.
          </p>
        </div>
        {address && (
          <div className="flex items-center gap-2">
            <a
              href={explorerAddress(address)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[12px] text-mist-400 hover:text-mist-200"
            >
              {addr(address)}
            </a>
            <Copy text={address} />
          </div>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {!revealed ? (
          <Button variant="ghost" onClick={reveal}>Show my recovery phrase</Button>
        ) : (
          <Button variant="ghost" onClick={() => setRevealed(null)}>Hide</Button>
        )}
        <Button variant="ghost" onClick={() => { setImporting((v) => !v); setErr(null); }}>
          Restore from a phrase
        </Button>
        <Button variant="danger" onClick={forget}>Forget on this device</Button>
      </div>

      {revealed && (
        <div className="mt-4 space-y-2">
          <Notice tone="error">
            Anyone with this can change your accounts&rsquo; rules. Never type it into another site.{" "}
            <span className="text-mist-300">
              Losing it doesn&rsquo;t lose your XRP — your accounts keep obeying the rules you set, and can
              still pay whoever those rules already allow — but the rules could never be changed again.
            </span>
          </Notice>
          {/* No copy button, deliberately: a clipboard is the easiest place for this to leak from, and a
              twelve-word phrase is short enough to write. Select it by hand if a password manager is where
              it's going. */}
          {revealed.isPhrase ? (
            <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border hairline bg-ink-950 p-4 sm:grid-cols-3">
              {revealed.secret.split(" ").map((w, i) => (
                <li key={i} className="flex items-baseline gap-2 font-mono text-[13px]">
                  <span className="w-5 shrink-0 text-right text-[11px] text-mist-500">{i + 1}</span>
                  <span className="text-mist-100">{w}</span>
                </li>
              ))}
            </ol>
          ) : (
            <code className="block break-all rounded-lg border hairline bg-ink-950 px-3.5 py-3 font-mono text-[12px] text-mist-200">
              {revealed.secret}
            </code>
          )}
        </div>
      )}

      {importing && (
        <div className="mt-4 space-y-2">
          <Notice tone="warn">
            Importing replaces this device&rsquo;s control key. Make sure you&rsquo;ve backed up the current
            one first if you still need it.
          </Notice>
          <div className="flex gap-2">
            <input
              value={pkInput}
              onChange={(e) => setPkInput(e.target.value)}
              placeholder="your twelve words, or a 0x… key"
              className="w-full rounded-lg border hairline bg-ink-950 px-3.5 py-2.5 font-mono text-sm text-mist-100 outline-none focus:border-signal-500/60"
            />
            <Button onClick={doImport}>Import</Button>
          </div>
          {err && <p className="text-[12px] text-refuse-500">{err}</p>}
        </div>
      )}
    </Card>
  );
}
