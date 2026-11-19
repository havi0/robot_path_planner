/** First-run onboarding screen (also reachable from Settings). Full screen, outside the app shell. */
import { motion } from "framer-motion";
import { ArrowRight, Zap } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { DotGlobeHero } from "../components/ui/globe-hero";
import { Logo } from "../components/layout/Sidebar";
import { webglAvailable } from "../components/three/Scene3DView";
import { finishOnboarding } from "../lib/onboarding";
import { usePrefs } from "../lib/prefs";

export default function Welcome() {
  const nav = useNavigate();
  const { reduceMotion } = usePrefs();
  const sysReduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = reduceMotion || sysReduced;
  const go = (to: string) => { finishOnboarding(); nav(to, { replace: true }); };

  return (
    <DotGlobeHero rotationSpeed={0.004} still={still} noCanvas={!webglAvailable()} globeRadius={1} color="#f1efff"
      className="h-full bg-[radial-gradient(1100px_650px_at_50%_42%,#1a1a1f,#0a0a0c_70%)]">
      <div className="absolute inset-0 bg-gradient-to-t from-[#0a0b0f]/70 via-transparent to-[#0a0b0f]/40" />
      <div className="absolute left-1/4 top-1/4 h-96 w-96 animate-pulse rounded-full bg-white/[0.04] blur-3xl" />
      <div className="absolute bottom-1/4 right-1/4 h-64 w-64 animate-pulse rounded-full bg-violet/[0.05] blur-3xl" />

      <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-6 py-5 md:px-10">
        <Logo collapsed={false} />
        <button onClick={() => go("/")} className="rounded-lg px-3 py-1.5 text-[13px] text-ink-3 hover:bg-white/[0.05] hover:text-ink">Skip</button>
      </header>

      <div className="relative z-10 mx-auto max-w-5xl space-y-12 px-6 py-12 text-center">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8 }} className="space-y-8">
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6, delay: 0.2 }}
            className="relative inline-flex items-center gap-3 rounded-full border border-white/20 bg-gradient-to-r from-white/[0.12] via-white/[0.06] to-white/[0.12] px-6 py-3 shadow-2xl backdrop-blur-xl">
            <div className="absolute inset-0 animate-pulse rounded-full bg-gradient-to-r from-white/[0.06] via-transparent to-white/[0.06]" />
            <div className="h-2 w-2 rounded-full bg-white/50 shadow-[0_0_8px_#ffffff80]" />
            <span className="relative z-10 text-[12.5px] font-bold uppercase tracking-wider text-white/90">Autonomous navigation</span>
            <div className="h-2 w-2 rounded-full bg-white/50 shadow-[0_0_8px_#ffffff80]" />
          </motion.div>

          <motion.h1 initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1, delay: 0.3 }}
            className="select-none text-5xl font-black leading-[0.85] tracking-tighter md:text-7xl lg:text-8xl xl:text-9xl">
            <span className="mb-3 block text-4xl font-light text-white/70 md:text-6xl lg:text-7xl">Teach robots</span>
            <span className="relative block">
              <span className="relative z-10 bg-gradient-to-br from-white via-[#ecebf3] to-[#9d9bb0] bg-clip-text font-black text-transparent">to navigate</span>
              <span aria-hidden className="absolute inset-0 scale-105 bg-gradient-to-br from-white via-[#d9d6ff] to-[#8b7cf6] bg-clip-text font-black text-transparent opacity-40 blur-2xl">to navigate</span>
              <motion.span initial={{ width: 0 }} animate={{ width: "100%" }} transition={{ duration: 1.5, delay: 1.2, ease: "easeOut" }}
                className="absolute -bottom-6 left-0 block h-3 rounded-full bg-gradient-to-r from-white via-white/80 to-transparent shadow-lg shadow-white/30" />
            </span>
          </motion.h1>

          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.8 }} className="mx-auto max-w-3xl space-y-4 pt-4">
            <p className="text-xl font-medium leading-relaxed text-ink-2 md:text-2xl">
              Train robots to reach their goal with{" "}
              <span className="rounded-md bg-white/10 px-2 py-1 font-semibold text-white">reinforcement learning</span>
            </p>
            <p className="text-lg leading-relaxed text-ink-3">
              Pick a robot, train or load a policy, watch it drive using only its LiDAR, and measure how reliably it avoids obstacles.
            </p>
          </motion.div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 1 }}
          className="flex flex-col items-center justify-center gap-6 pt-4 sm:flex-row">
          <motion.button onClick={() => go("/")}
            whileHover={{ scale: 1.05, y: -2, boxShadow: "0 20px 40px rgba(0,0,0,0.35), 0 0 25px rgba(139,124,246,0.35)" }} whileTap={{ scale: 0.98 }}
            className="group relative inline-flex items-center gap-3 overflow-hidden rounded-xl border border-violet/20 bg-gradient-to-r from-[#9b8eff] via-violet to-[#7b6cf0] px-8 py-4 text-lg font-semibold text-white shadow-xl transition-shadow duration-500">
            <div className="absolute inset-0 bg-gradient-to-r from-white/20 via-white/5 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            <motion.div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent" initial={{ x: "-100%" }} whileHover={{ x: "100%" }} transition={{ duration: 0.8 }} />
            <span className="relative z-10 tracking-wide">Start Exploring</span>
            <ArrowRight className="relative z-10 h-5 w-5 transition-transform duration-300 group-hover:translate-x-2" />
          </motion.button>

          <motion.button onClick={() => go("/simulation")}
            whileHover={{ scale: 1.05, y: -2, borderColor: "rgba(139,124,246,0.6)", boxShadow: "0 15px 30px rgba(0,0,0,0.3), 0 0 15px rgba(139,124,246,0.15)" }} whileTap={{ scale: 0.98 }}
            className="group relative inline-flex items-center gap-3 overflow-hidden rounded-xl border-2 border-white/10 bg-[#0d0e13]/60 px-8 py-4 text-lg font-semibold text-ink shadow-lg backdrop-blur-xl transition-colors duration-500 hover:bg-[#0d0e13]/90">
            <div className="absolute inset-0 bg-gradient-to-r from-violet/5 via-transparent to-violet/5 opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            <Zap className="relative z-10 h-5 w-5 transition-all duration-300 group-hover:rotate-6 group-hover:scale-110" />
            <span className="relative z-10 tracking-wide">View Live Demo</span>
          </motion.button>
        </motion.div>
      </div>
    </DotGlobeHero>
  );
}
