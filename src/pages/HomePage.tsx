import React from 'react';
import { useShop } from '../context/ShopContext';
import { HeroBanner } from '../components/HeroBanner';
import { SearchBar } from '../components/SearchBar';
import { FeaturedCollections } from '../components/FeaturedCollections';
import { ProductCard } from '../components/ProductCard';
import { AboutIntroduction } from '../components/AboutIntroduction';
import { NewsletterSection } from '../components/NewsletterSection';
import { ArrowRight, Sparkles } from 'lucide-react';

export const HomePage: React.FC = () => {
  const { products, setCurrentPage } = useShop();

  // Exactly maximum 4 New Arrivals
  const newArrivals = products.filter((p) => p.isNewArrival).slice(0, 4);

  // Exactly maximum 4 Best Sellers
  const bestSellers = products.filter((p) => p.isBestSeller).slice(0, 4);

  return (
    <div className="flex flex-col w-full">
      {/* 1. Unified Hero Campaign Banner */}
      <HeroBanner />

      {/* 2. New Arrivals Product Section (Immediately below Hero) */}
      <section className="py-6 sm:py-10 lg:py-12 bg-[#09090C] border-b border-[#1B1B21]">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-5 sm:mb-8 gap-2 sm:gap-4">
            <div>
              <div className="flex items-center gap-2 text-[11px] sm:text-xs uppercase tracking-[0.25em] text-[#D4AF37] font-semibold mb-1">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Atelier Premiere</span>
              </div>
              <h2 className="font-brand text-2xl sm:text-3xl lg:text-4xl font-bold tracking-wider text-white">
                New Arrivals
              </h2>
            </div>
            <button
              onClick={() => {
                setCurrentPage('new-arrivals');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-[#E6C25B] hover:text-white font-semibold transition-colors cursor-pointer group self-start sm:self-auto"
            >
              <span>Explore All New Pieces</span>
              <ArrowRight className="w-4 h-4 text-[#D4AF37] group-hover:translate-x-1 transition-transform" />
            </button>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-5 xl:gap-6">
            {newArrivals.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </div>
      </section>

      {/* 3. Interactive Catalog Search Bar */}
      <div className="w-full bg-[#08080A] py-5 sm:py-7 px-3 sm:px-6 lg:px-8 border-b border-[#1E1E24]">
        <SearchBar />
      </div>

      {/* 4. Featured Collections */}
      <FeaturedCollections />

      {/* 5. Best Sellers Showcase */}
      <section className="py-10 sm:py-16 bg-[#08080B] border-b border-[#1B1B21]">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-6 sm:mb-10 gap-2 sm:gap-4">
            <div>
              <div className="flex items-center gap-2 text-[11px] sm:text-xs uppercase tracking-[0.25em] text-[#D4AF37] font-semibold mb-1">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Curated Icons</span>
              </div>
              <h2 className="font-brand text-2xl sm:text-3xl lg:text-4xl font-bold tracking-wider text-white">
                Best Sellers
              </h2>
            </div>
            <button
              onClick={() => {
                setCurrentPage('best-sellers');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-[#E6C25B] hover:text-white font-semibold transition-colors cursor-pointer group self-start sm:self-auto"
            >
              <span>View All Best Sellers</span>
              <ArrowRight className="w-4 h-4 text-[#D4AF37] group-hover:translate-x-1 transition-transform" />
            </button>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-5 xl:gap-6">
            {bestSellers.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </div>
      </section>

      {/* 6. Short About RGD LUXE Introduction with Read More Button */}
      <AboutIntroduction />

      {/* 7. Newsletter Subscription */}
      <NewsletterSection />
    </div>
  );
};
