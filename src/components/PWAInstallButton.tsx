import React, { useState } from 'react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { Download, Smartphone, X } from 'lucide-react';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        onClick={install}
        className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-black shadow-lg shadow-teal-600/20 transition-all hover:scale-105 active:scale-95 cursor-pointer"
        title="تثبيت التطبيق على جهازك"
      >
        <Download className="w-4 h-4" />
        <span>تثبيت التطبيق</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-black shadow-lg shadow-teal-600/20 transition-all hover:scale-105 active:scale-95 cursor-pointer"
          title="تثبيت على أجهزة ايفون / ايباد"
        >
          <Smartphone className="w-4 h-4" />
          <span>تثبيت التطبيق</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
            <div className="bg-white dark:bg-slate-900 w-full max-w-sm rounded-[2rem] p-6 shadow-2xl border border-slate-200 dark:border-slate-800 text-right">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-black text-slate-900 dark:text-white">تثبيت التطبيق على الايفون</h3>
                <button onClick={() => setShowIOSGuide(false)} className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full">
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed space-y-2 mb-6">
                1. اضغط على زر <strong>المشاركة (Share)</strong> في شريط متصفح Safari.<br/><br/>
                2. انزل لأسفل القائمة واختر <strong>"إضافة إلى الشاشة الرئيسية" (Add to Home Screen)</strong>.
              </p>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="w-full py-3 bg-slate-900 text-white rounded-xl text-xs font-black hover:bg-slate-800 transition-all"
              >
                فهمت
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <button
      onClick={() => alert('لتثبيت التطبيق، يمكنك النقر على أيقونة التثبيت في شريط العنوان أعلى المتصفح (Chrome/Edge/Safari)، أو فتح القائمة واختيار "تثبيت التطبيق".')}
      className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 rounded-xl text-xs font-black transition-all cursor-pointer"
      title="كيفية تثبيت التطبيق"
    >
      <Download className="w-4 h-4" />
      <span>تثبيت التطبيق</span>
    </button>
  );
};

export default PWAInstallButton;
