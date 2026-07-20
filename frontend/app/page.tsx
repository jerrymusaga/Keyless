import { Hero } from "@/components/Hero";
import { TrustBar, Features, HowItWorks, SeeBand, Security, FinalCTA } from "@/components/marketing";
import { Roadmap } from "@/components/Roadmap";
import { Footer } from "@/components/Footer";

/**
 * A conventional product landing (wallet-style), dark theme: hero with a live app
 * mockup, trust bar, the rule templates, how-it-works, a pull to the live /see
 * demo, the security argument, roadmap, and a final call to action. The old
 * editorial single-narrative sections (Control/Refuse/Evidence) now live as the
 * interactive proof at /see.
 */
export default function Page() {
  return (
    <main>
      <Hero />
      <TrustBar />
      <Features />
      <HowItWorks />
      <SeeBand />
      <Security />
      <Roadmap />
      <FinalCTA />
      <Footer />
    </main>
  );
}
