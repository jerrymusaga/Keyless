import { Hero } from "@/components/Hero";
import { Control } from "@/components/Control";
import { Refuse } from "@/components/Refuse";
import { Evidence } from "@/components/Evidence";
import { Flagship } from "@/components/Flagship";
import { Footer } from "@/components/Footer";

/**
 * Narrative order is load-bearing: the problem, then who holds the power, then
 * the refusal (live), then the payment (recorded), then where it goes. The tech
 * only ever appears as the answer to a question already asked.
 */
export default function Page() {
  return (
    <main>
      <Hero />
      <Control />
      <Refuse />
      <Evidence />
      <Flagship />
      <Footer />
    </main>
  );
}
