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
  const { address, exportKey, importKey, forget } = useKeyless();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [pkInput, setPkInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reveal = () => setRevealed(exportKey());
  const copy = async () => {
    if (!revealed) return;
    await navigator.clipboard.writeText(revealed);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const doImport = () => {
    setErr(null);
    try {
      const pk = pkInput.trim();
      importKey((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
      setImporting(false);
      setPkInput("");
    } catch {
      setErr("That doesn't look like a valid private key.");
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
          <Button variant="ghost" onClick={reveal}>Back up / export key</Button>
        ) : (
          <Button variant="ghost" onClick={() => setRevealed(null)}>Hide key</Button>
        )}
        <Button variant="ghost" onClick={() => { setImporting((v) => !v); setErr(null); }}>
          Import a key
        </Button>
        <Button variant="danger" onClick={forget}>Forget on this device</Button>
      </div>

      {revealed && (
        <div className="mt-4 space-y-2">
          <Notice tone="error">
            Anyone with this key can change your accounts&rsquo; rules. Never paste it into a site or share
            it. Store it somewhere only you control.
          </Notice>
          <div className="flex items-center gap-2 rounded-lg border hairline bg-ink-950 px-3.5 py-3">
            <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-mist-200">{revealed}</code>
            <button onClick={copy} className="shrink-0 rounded-md border hairline bg-ink-850 px-2.5 py-1 text-[11px] text-mist-300 hover:text-mist-100">
              {copied ? "copied" : "copy"}
            </button>
          </div>
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
              placeholder="0x… private key"
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
