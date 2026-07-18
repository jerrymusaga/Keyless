import { Hero } from "@/components/Hero";
import { Control } from "@/components/Control";
import { Templates } from "@/components/Templates";
import { Refuse } from "@/components/Refuse";
import { Evidence } from "@/components/Evidence";
import { Roadmap } from "@/components/Roadmap";
import { Footer } from "@/components/Footer";

/**
 * Narrative order is load-bearing: the problem (hero), then who holds the key
 * (nobody — a contract does), then what you can build (rule templates), then the
 * refusal (live), then the proof it moved real XRP (recorded), then where it
 * goes. The tech only ever appears as the answer to a question already asked.
 */
export default function Page() {
  return (
    <main>
      <Hero />
      <Control />
      <Templates />
      <Refuse />
      <Evidence />
      <Roadmap />
      <Footer />
    </main>
  );
}
