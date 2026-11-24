import React from 'react';
import { useShop } from '../context/ShopContext';
import { PageView } from '../types';
import { ArrowRight, Sparkles } from 'lucide-react';
import { OptimizedImage } from './OptimizedImage';

interface CollectionCardData {
  id: string;
  title: string;
  subtitle: string;
  tagline: string;
  image: string;
  page: PageView;
}

export const FeaturedCollections: React.FC = () => {
  const { setCurrentPage } = useShop();

  const collections: CollectionCardData[] = [
    {
      id: 'men',
      title: "Men's Collection",
      subtitle: 'Sartorial Italian Tailoring',
      tagline: 'Super 160s Virgin Wool & Silk Faille',
      image: '/assets/images/men_collection_suit_1794494077378.jpg',
      page: 'men',
    },
    {
      id: 'women',
      title: "Women's Collection",
      subtitle: 'Architectural Evening Couture',
      tagline: 'Hand-Embroidered Velvet & Mulberry Silks',
      image: '/assets/images/women_evening_dress_1794494078742.jpg',
      page: 'women',
    },
    {
      id: 'watches',
      title: 'Luxury Watches',
      subtitle: 'Haute Horlogerie & Chronographs',
      tagline: '18K Solid Gold & Flying Tourbillons',
      image: '/assets/images/watch_rose_gold_1794494079347.jpg',
      page: 'watches',
    },
    {
      id: 'new-arrivals',
      title: 'New Arrivals',
      subtitle: 'The 2026 Atelier Premiere',
      tagline: 'Limited Production Masterpieces',
      image: '/assets/images/watch_black_diamond_1794494079598.jpg',
      page: 'new-arrivals',
    },
  ];

  return (
    <section className="py-12 sm:py-16 bg-[#08080B] border-b border-[#1C1C22]">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between mb-7 sm:mb-10 gap-3 sm:gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] sm:text-xs uppercase tracking-[0.25em] text-[#D4AF37] font-semibold mb-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Signature Pillars</span>
            </div>
            <h2 className="font-brand text-2xl sm:text-3xl lg:text-4xl font-bold tracking-wider text-neutral-100">
              Featured Collections
            </h2>
          </div>
          <p className="text-xs sm:text-sm text-neutral-400 max-w-md font-light leading-relaxed">
            Every garment and timepiece is handcrafted in strictly limited numbers, honoring centuries of European atelier tradition.
          </p>
        </div>

        {/* 4 Luxury Collection Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6 lg:gap-7">
          {collections.map((col) => (
            <div
              key={col.id}
              onClick={() => {
                setCurrentPage(col.page);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="group relative h-[230px] sm:h-[340px] lg:h-[400px] rounded-xl sm:rounded-2xl overflow-hidden border border-[#262630] hover:border-[#D4AF37]/70 transition-all duration-500 cursor-pointer shadow-lg hover:shadow-[0_0_30px_rgba(212,175,55,0.25)] flex flex-col justify-end p-3.5 sm:p-6"
            >
              {/* Background Optimized Image */}
              <OptimizedImage
                src={col.image}
                alt={col.title}
                sizes="(max-width: 1023px) 46vw, 290px"
                className="absolute inset-0 w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-700 ease-out"
              />

              {/* Scrim Overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/50 to-transparent transition-opacity duration-300" />
              <div className="absolute inset-0 bg-black/20 group-hover:bg-transparent transition-colors duration-300" />

              {/* Content Box */}
              <div className="relative z-10">
                <span className="text-[9px] sm:text-[11px] uppercase tracking-[0.16em] sm:tracking-[0.2em] text-[#F3E5AB] font-semibold block truncate">
                  {col.subtitle}
                </span>
                <h3 className="font-brand text-base sm:text-xl lg:text-2xl font-bold text-white mt-0.5 sm:mt-1 group-hover:text-gold-gradient transition-colors leading-tight">
                  {col.title}
                </h3>
                <p className="hidden sm:block text-xs text-neutral-300 mt-1.5 line-clamp-1 font-light">
                  {col.tagline}
                </p>

                <div className="mt-2.5 sm:mt-4 pt-2 sm:pt-3 border-t border-white/10 flex items-center justify-between">
                  <span className="text-[10px] sm:text-xs font-medium uppercase tracking-wider text-[#D4AF37] group-hover:underline">
                    Explore
                  </span>
                  <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-white/10 group-hover:bg-[#D4AF37] text-white group-hover:text-black flex items-center justify-center transition-all duration-300">
                    <ArrowRight className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
