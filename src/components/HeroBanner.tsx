import React from 'react';
import { useShop } from '../context/ShopContext';
import { ArrowRight, Watch } from 'lucide-react';
import { OptimizedImage } from './OptimizedImage';

export const HeroBanner: React.FC = () => {
  const { setCurrentPage } = useShop();

  return (
    <section
      aria-label="Maison RGD LUXE Featured Campaign"
      className="relative w-full overflow-hidden bg-[#050507] border-b border-[#24242A]"
    >
      <div className="relative w-full min-h-[250px] sm:min-h-[340px] md:min-h-[370px] lg:min-h-[440px] xl:min-h-[500px] flex items-end sm:items-center">
        {/* Unified Priority Campaign Image — full-bleed on mobile, right-anchored proportional canvas on tablet/laptop/desktop */}
        <div className="absolute inset-0 sm:left-auto sm:right-2 md:right-3 lg:right-2 xl:right-0 sm:w-[76%] md:w-[72%] lg:w-[68%] xl:w-[65%] z-0 overflow-hidden bg-[#050507]">
          <OptimizedImage
            src="/assets/aistudio/image_4a962f72_73843b7b.jpg"
            alt="RGD LUXE Timeless Style Modern Luxury Campaign"
            priority
            sizes="(max-width: 639px) 100vw, (max-width: 1023px) 74vw, 66vw"
            className="w-full h-full object-cover object-[68%_22%] sm:object-[92%_16%] md:object-[94%_16%] lg:object-[88%_14%] xl:object-[72%_14%] 2xl:object-[50%_14%] opacity-95"
          />
          {/* Subtle top/bottom vignette to blend into surrounding dark bands */}
          <div className="absolute inset-0 bg-gradient-to-t from-[#050507] via-[#050507]/25 to-[#050507]/40 sm:from-[#050507]/75 sm:via-transparent sm:via-20% sm:to-[#050507]/30" />
          {/* Left feathered edge inside the image frame so the campaign backdrop dissolves invisibly into #050507 */}
          <div className="hidden sm:block absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-[#050507] via-[#050507]/70 to-transparent" />
        </div>

        {/* Continuous full-stage horizontal scrim for cohesive mobile & desktop text integration */}
        <div className="absolute inset-0 z-[1] pointer-events-none bg-gradient-to-r from-[#050507]/95 via-[#050507]/68 to-[#050507]/20 sm:bg-[linear-gradient(90deg,#050507_0%,#050507_26%,rgba(5,5,7,0.84)_38%,rgba(5,5,7,0.18)_52%,transparent_66%)]" />
        <div className="sm:hidden absolute inset-0 z-[1] pointer-events-none bg-gradient-to-t from-[#050507]/95 via-[#050507]/40 to-transparent" />

        {/* Hero Copy & Primary Actions Integrated Seamlessly (No Disconnected Floating Box) */}
        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8 lg:py-12 w-full">
          <div className="max-w-md sm:max-w-[390px] md:max-w-[420px] lg:max-w-[450px] xl:max-w-[490px]">
            <div className="text-[10px] sm:text-[11px] uppercase tracking-[0.22em] sm:tracking-[0.26em] font-semibold text-[#F3E5AB] mb-1.5 sm:mb-2">
              New York · Geneva · Paris
            </div>

            <h1 className="font-brand text-2xl sm:text-4xl lg:text-5xl xl:text-[3.5rem] font-extrabold tracking-[0.14em] text-gold-gradient uppercase leading-none drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)]">
              RGD LUXE
            </h1>

            <p className="mt-1.5 sm:mt-2.5 font-editorial text-sm sm:text-xl lg:text-[1.45rem] text-neutral-100 italic tracking-wide font-normal drop-shadow-[0_1px_8px_rgba(0,0,0,0.75)]">
              "TIMELESS STYLE. MODERN LUXURY."
            </p>

            <p className="mt-1.5 sm:mt-3 text-xs sm:text-sm text-neutral-200 sm:text-neutral-300 leading-relaxed font-light max-w-sm sm:max-w-[360px] md:max-w-[385px] lg:max-w-md">
              Discover the Art of Refined Living. An exclusive synthesis of master-tailored evening couture and Swiss-certified mechanical timepieces.
            </p>

            <div className="mt-3.5 sm:mt-6 flex flex-wrap items-center gap-2.5 sm:gap-3.5">
              <button
                onClick={() => {
                  setCurrentPage('shop');
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className="group inline-flex items-center justify-center gap-2 px-4 sm:px-6 py-2.5 sm:py-3 min-h-[40px] bg-gradient-to-r from-[#D4AF37] via-[#F3E5AB] to-[#C99726] text-black font-semibold text-[11px] sm:text-xs tracking-wider uppercase rounded-full shadow-[0_0_20px_rgba(212,175,55,0.35)] hover:shadow-[0_0_28px_rgba(212,175,55,0.55)] transition-all duration-300 cursor-pointer whitespace-nowrap"
              >
                <span>Shop Now</span>
                <ArrowRight className="w-3.5 h-3.5 sm:w-4 sm:h-4 group-hover:translate-x-0.5 transition-transform" />
              </button>

              <button
                onClick={() => {
                  setCurrentPage('watches');
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className="inline-flex items-center justify-center gap-1.5 sm:gap-2 px-3.5 sm:px-5 py-2.5 sm:py-3 min-h-[40px] bg-[#0F0F14]/90 hover:bg-[#1A1A22] border border-[#D4AF37]/50 hover:border-[#D4AF37] text-neutral-200 hover:text-white text-[11px] sm:text-xs font-medium tracking-wider uppercase rounded-full backdrop-blur-md transition-all duration-300 cursor-pointer whitespace-nowrap"
              >
                <Watch className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#D4AF37]" />
                <span>Horology Salon</span>
              </button>
            </div>

            <div className="hidden sm:flex mt-5 pt-3.5 border-t border-[#D4AF37]/20 items-center gap-x-2 lg:gap-x-3.5 gap-y-1 text-[10.5px] lg:text-[11px] text-neutral-300 whitespace-nowrap">
              <span>Original Swiss Calibres</span>
              <span aria-hidden="true" className="text-[#D4AF37]">·</span>
              <span>Bespoke Italian Silks</span>
              <span aria-hidden="true" className="text-[#D4AF37]">·</span>
              <span>White-Glove Delivery</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
