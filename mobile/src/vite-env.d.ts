/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_PLATFORM_BRAND_NAME?: string;
  readonly VITE_PLATFORM_SUPPORT_EMAIL?: string;
  readonly VITE_PLATFORM_BRAND_ACCENT_HSL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
