"use client";

import { useState } from "react";
import { useKeyless } from "./KeylessProvider";
import { Button, Card, Notice } from "./ui";

/**
 * Write your recovery phrase down — before you own anything worth losing.
 *
 * A tester's account of the old flow: the backup option "at the bottom of the page can make it seem less
 * important & be missed initially", and losing the secret felt like losing everything. Nothing had ever
 * asked them to save it. So this stands in front of account creation rather than beside it, and the only
 * way past is to say you've done it.
 *
 * There is deliberately no copy button. Their argument — "no-one should ever copy paste this key, the risk
 * of it being found on a device clipboard is high" — is why writing it down has to be realistic, and a
 * twelve-word phrase is. A password manager is still a good home for it; that's what Reveal on the control
 * key panel is for, once you've got a written copy that doesn't depend on a device.
 */
export function BackupGate({ onDone }: { onDone?: () => void }) {
  const { exportSecret, confirmBackedUp } = useKeyless();
  const [shown, setShown] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const secret = exportSecret();

  if (!secret) return null;
  const words = secret.isPhrase ? secret.secret.split(" ") : null;

  return (
    <Card className="border-warn-500/30 bg-warn-500/[0.03]">
      <h2 className="text-[15px] font-medium text-mist-100">Write this down before you go further</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-mist-400">
        This is your <span className="text-mist-200">control key</span> — the only thing that can change your
        accounts&rsquo; rules. We don&rsquo;t have a copy. Nobody can send it to you again.
      </p>

      {!shown ? (
        <div className="mt-5">
          <Button onClick={() => setShown(true)}>Show my {secret.isPhrase ? "recovery phrase" : "key"}</Button>
          <p className="mt-2 text-[11px] text-mist-500">Make sure nobody can see your screen.</p>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          {words ? (
            <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border hairline bg-ink-950 p-4 sm:grid-cols-3">
              {words.map((w, i) => (
                <li key={i} className="flex items-baseline gap-2 font-mono text-[13px]">
                  <span className="w-5 shrink-0 text-right text-[11px] text-mist-500">{i + 1}</span>
                  <span className="text-mist-100">{w}</span>
                </li>
              ))}
            </ol>
          ) : (
            <code className="block break-all rounded-lg border hairline bg-ink-950 p-4 font-mono text-[12px] text-mist-200">
              {secret.secret}
            </code>
          )}

          <Notice tone="warn">
            <span className="font-medium">Write it on paper, in order.</span> Anyone who has it can change
            what your accounts are allowed to do. Losing it doesn&rsquo;t lose your XRP — your accounts keep
            obeying the rules you set, and can still pay whoever those rules already allow — but nobody,
            including us, could ever change those rules again.
          </Notice>

          <label className="flex items-start gap-2.5 text-[13px] text-mist-300">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-signal-500"
            />
            <span>I&rsquo;ve written it down somewhere only I can reach.</span>
          </label>

          <Button disabled={!confirmed} onClick={() => { confirmBackedUp(); onDone?.(); }}>
            Continue
          </Button>
        </div>
      )}

      <details className="mt-5 text-[12px] text-mist-500">
        <summary className="cursor-pointer hover:text-mist-300">How is this generated?</summary>
        <p className="mt-2 leading-relaxed">
          In your browser, by your browser: <code className="font-mono text-mist-400">crypto.getRandomValues</code>{" "}
          — the operating system&rsquo;s cryptographic random source — turned into a standard BIP-39 phrase.
          It is never sent anywhere, and no server ever sees it. The XRP keys are different again: those are
          generated inside the enclave and cannot be exported by anyone, including us.
        </p>
      </details>
    </Card>
  );
}
