/* =====================================================================
 * SlimBANK - настройки сервера
 * Замени две строки ниже на свои из Supabase:
 *   Project Settings -> API -> Project URL  и  anon public key
 * Анонимный ключ публичный, его МОЖНО держать в репозитории.
 * НИКОГДА не клади сюда service_role key.
 * ===================================================================== */
window.SLIM_SUPABASE = {
  url: "https://jgvwbckjoiqmnrpnrqon.supabase.co",
  anonKey: "sb_publishable_WKawk6BW9dfhgX7GswG5qQ_43giuHa8",

  autoRegister: true,    // автоматически создавать аккаунт на сервере при регистрации
  serverAccruals: true,  // начислять проценты по тарифу на сервере (честное время)
  serverPromos: true,    // промокоды проверяет сервер
  debug: false           // true = логи в консоли браузера
};
