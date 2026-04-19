import React, { useState, useEffect } from 'react'
import { Info, Github, Shield, Key, Users, Database, Upload, Clock, Puzzle, CalendarDays, Globe, ArrowRightLeft, Map, Briefcase, ListChecks, Wallet, FileText, Plane } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface DemoTexts {
  titleBefore: string
  titleAfter: string
  title: string
  description: string
  resetIn: string
  minutes: string
  uploadNote: string
  fullVersionTitle: string
  features: string[]
  addonsTitle: string
  addons: [string, string][]
  whatIs: string
  whatIsDesc: string
  selfHost: string
  selfHostLink: string
  close: string
}

const texts: Record<string, DemoTexts> = {
  de: {
    titleBefore: 'Willkommen bei ',
    titleAfter: '',
    title: 'Willkommen zur TREK Demo',
    description: 'Du kannst Reisen ansehen, bearbeiten und eigene erstellen. Alle Aenderungen werden jede Stunde automatisch zurueckgesetzt.',
    resetIn: 'Naechster Reset in',
    minutes: 'Minuten',
    uploadNote: 'Datei-Uploads (Fotos, Dokumente, Cover) sind in der Demo deaktiviert.',
    fullVersionTitle: 'In der Vollversion zusaetzlich:',
    features: [
      'Datei-Uploads (Fotos, Dokumente, Cover)',
      'API-Schluessel (Google Maps, Wetter)',
      'Benutzer- & Rechteverwaltung',
      'Automatische Backups',
      'Addon-Verwaltung (aktivieren/deaktivieren)',
      'OIDC / SSO Single Sign-On',
    ],
    addonsTitle: 'Modulare Addons (in der Vollversion deaktivierbar)',
    addons: [
      ['Vacay', 'Urlaubsplaner mit Kalender, Feiertagen & Fusion'],
      ['Atlas', 'Weltkarte mit besuchten Laendern & Reisestatistiken'],
      ['Packliste', 'Checklisten pro Reise'],
      ['Budget', 'Kostenplanung mit Splitting'],
      ['Dokumente', 'Dateien an Reisen anhaengen'],
      ['Widgets', 'Waehrungsrechner & Zeitzonen'],
    ],
    whatIs: 'Was ist TREK?',
    whatIsDesc: 'Ein selbst-gehosteter Reiseplaner mit Echtzeit-Kollaboration, interaktiver Karte, OIDC Login und Dark Mode.',
    selfHost: 'Open Source — ',
    selfHostLink: 'selbst hosten',
    close: 'Verstanden',
  },
  en: {
    titleBefore: 'Welcome to ',
    titleAfter: '',
    title: 'Welcome to the TREK Demo',
    description: 'You can view, edit and create trips. All changes are automatically reset every hour.',
    resetIn: 'Next reset in',
    minutes: 'minutes',
    uploadNote: 'File uploads (photos, documents, covers) are disabled in demo mode.',
    fullVersionTitle: 'Additionally in the full version:',
    features: [
      'File uploads (photos, documents, covers)',
      'API key management (Google Maps, Weather)',
      'User & permission management',
      'Automatic backups',
      'Addon management (enable/disable)',
      'OIDC / SSO single sign-on',
    ],
    addonsTitle: 'Modular Addons (can be deactivated in full version)',
    addons: [
      ['Vacay', 'Vacation planner with calendar, holidays & user fusion'],
      ['Atlas', 'World map with visited countries & travel stats'],
      ['Packing', 'Checklists per trip'],
      ['Budget', 'Expense tracking with splitting'],
      ['Documents', 'Attach files to trips'],
      ['Widgets', 'Currency converter & timezones'],
    ],
    whatIs: 'What is TREK?',
    whatIsDesc: 'A self-hosted travel planner with real-time collaboration, interactive maps, OIDC login and dark mode.',
    selfHost: 'Open source — ',
    selfHostLink: 'self-host it',
    close: 'Got it',
  },
  es: {
    titleBefore: 'Bienvenido a ',
    titleAfter: '',
    title: 'Bienvenido a la demo de TREK',
    description: 'Puedes ver, editar y crear viajes. Todos los cambios se restablecen automáticamente cada hora.',
    resetIn: 'Próximo reinicio en',
    minutes: 'minutos',
    uploadNote: 'Las subidas de archivos (fotos, documentos, portadas) están desactivadas en el modo demo.',
    fullVersionTitle: 'Además, en la versión completa:',
    features: [
      'Subida de archivos (fotos, documentos, portadas)',
      'Gestión de claves API (Google Maps, tiempo)',
      'Gestión de usuarios y permisos',
      'Copias de seguridad automáticas',
      'Gestión de addons (activar/desactivar)',
      'Inicio de sesión único OIDC / SSO',
    ],
    addonsTitle: 'Complementos modulares (se pueden desactivar en la versión completa)',
    addons: [
      ['Vacaciones', 'Planificador de vacaciones con calendario, festivos y fusión de usuarios'],
      ['Atlas', 'Mapa del mundo con países visitados y estadísticas de viaje'],
      ['Equipaje', 'Listas de comprobación para cada viaje'],
      ['Presupuesto', 'Control de gastos con reparto'],
      ['Documentos', 'Adjunta archivos a los viajes'],
      ['Widgets', 'Conversor de divisas y zonas horarias'],
    ],
    whatIs: '¿Qué es TREK?',
    whatIsDesc: 'Un planificador de viajes autohospedado con colaboración en tiempo real, mapas interactivos, inicio de sesión OIDC y modo oscuro.',
    selfHost: 'Código abierto — ',
    selfHostLink: 'alójalo tú mismo',
    close: 'Entendido',
  },
  zh: {
    titleBefore: '欢迎来到 ',
    titleAfter: '',
    title: '欢迎来到 TREK 演示版',
    description: '你可以查看、编辑和创建旅行。所有更改都会在每小时自动重置。',
    resetIn: '下次重置将在',
    minutes: '分钟后',
    uploadNote: '演示模式下已禁用文件上传（照片、文档、封面）。',
    fullVersionTitle: '完整版本还包括：',
    features: [
      '文件上传（照片、文档、封面）',
      'API 密钥管理（Google Maps、天气）',
      '用户和权限管理',
      '自动备份',
      '附加组件管理（启用/禁用）',
      'OIDC / SSO 单点登录',
    ],
    addonsTitle: '模块化附加组件（完整版本可禁用）',
    addons: [
      ['Vacay', '带日历、节假日和用户融合的假期规划器'],
      ['Atlas', '带已访问国家和旅行统计的世界地图'],
      ['Packing', '按旅行管理清单'],
      ['Budget', '支持分摊的费用追踪'],
      ['Documents', '将文件附加到旅行'],
      ['Widgets', '货币换算和时区工具'],
    ],
    whatIs: '什么是 TREK？',
    whatIsDesc: '一个支持实时协作、交互式地图、OIDC 登录和深色模式的自托管旅行规划器。',
    selfHost: '开源项目 - ',
    selfHostLink: '自行部署',
    close: '知道了',
  },
  'zh-TW': {
    titleBefore: '歡迎來到 ',
    titleAfter: '',
    title: '歡迎來到 TREK 展示版',
    description: '你可以檢視、編輯和建立行程。所有變更都會在每小時自動重設。',
    resetIn: '下次重設將在',
    minutes: '分鐘後',
    uploadNote: '展示模式下已停用檔案上傳（照片、文件、封面）。',
    fullVersionTitle: '完整版本還包含：',
    features: [
      '檔案上傳（照片、文件、封面）',
      'API 金鑰管理（Google Maps、天氣）',
      '使用者與權限管理',
      '自動備份',
      '附加元件管理（啟用/停用）',
      'OIDC / SSO 單一登入',
    ],
    addonsTitle: '模組化附加元件（完整版本可停用）',
    addons: [
      ['Vacay', '具備日曆、假日與使用者融合的假期規劃器'],
      ['Atlas', '顯示已造訪國家與旅行統計的世界地圖'],
      ['Packing', '依行程管理的檢查清單'],
      ['Budget', '支援分攤的費用追蹤'],
      ['Documents', '將檔案附加到行程'],
      ['Widgets', '貨幣換算與時區工具'],
    ],
    whatIs: 'TREK 是什麼？',
    whatIsDesc: '一個支援即時協作、互動式地圖、OIDC 登入和深色模式的自架旅行規劃器。',
    selfHost: '開源專案 - ',
    selfHostLink: '自行架設',
    close: '知道了',
  },
  ar: {
    titleBefore: 'مرحبًا بك في ',
    titleAfter: '',
    title: 'مرحبًا بك في النسخة التجريبية من TREK',
    description: 'يمكنك عرض الرحلات وتعديلها وإنشاء رحلات جديدة. تتم إعادة ضبط جميع التغييرات تلقائيًا كل ساعة.',
    resetIn: 'إعادة الضبط التالية خلال',
    minutes: 'دقيقة',
    uploadNote: 'رفع الملفات (الصور والمستندات وصور الغلاف) معطّل في وضع العرض التجريبي.',
    fullVersionTitle: 'وفي النسخة الكاملة أيضًا:',
    features: [
      'رفع الملفات (الصور والمستندات وصور الغلاف)',
      'إدارة مفاتيح API (خرائط Google والطقس)',
      'إدارة المستخدمين والصلاحيات',
      'نسخ احتياطية تلقائية',
      'إدارة الإضافات (تفعيل/تعطيل)',
      'تسجيل دخول موحد OIDC / SSO',
    ],
    addonsTitle: 'إضافات مرنة (يمكن تعطيلها في النسخة الكاملة)',
    addons: [
      ['Vacay', 'مخطط إجازات مع تقويم وعطل ودمج مستخدمين'],
      ['Atlas', 'خريطة عالمية مع الدول التي تمت زيارتها وإحصاءات السفر'],
      ['Packing', 'قوائم تجهيز لكل رحلة'],
      ['Budget', 'تتبع المصروفات مع التقسيم'],
      ['Documents', 'إرفاق الملفات بالرحلات'],
      ['Widgets', 'محول عملات ومناطق زمنية'],
    ],
    whatIs: 'ما هو TREK؟',
    whatIsDesc: 'مخطط رحلات مستضاف ذاتيًا مع تعاون لحظي وخرائط تفاعلية وتسجيل دخول OIDC ووضع داكن.',
    selfHost: 'مفتوح المصدر — ',
    selfHostLink: 'استضفه بنفسك',
    close: 'فهمت',
  },
  fr: {
    titleBefore: 'Bienvenue sur ',
    titleAfter: '',
    title: 'Bienvenue sur la démo TREK',
    description: 'Vous pouvez consulter, modifier et créer des voyages. Toutes les modifications sont réinitialisées automatiquement chaque heure.',
    resetIn: 'Prochaine réinitialisation dans',
    minutes: 'minutes',
    uploadNote: "Les téléversements de fichiers (photos, documents, couvertures) sont désactivés en mode démo.",
    fullVersionTitle: 'En plus dans la version complète :',
    features: [
      'Téléversement de fichiers (photos, documents, couvertures)',
      'Gestion des clés API (Google Maps, météo)',
      'Gestion des utilisateurs et des permissions',
      'Sauvegardes automatiques',
      'Gestion des addons (activer/désactiver)',
      'Connexion unique OIDC / SSO',
    ],
    addonsTitle: 'Addons modulaires (désactivables dans la version complète)',
    addons: [
      ['Vacay', 'Planificateur de vacances avec calendrier, jours fériés et fusion'],
      ['Atlas', 'Carte du monde avec pays visités et statistiques de voyage'],
      ['Packing', 'Listes de contrôle par voyage'],
      ['Budget', 'Suivi des dépenses avec répartition'],
      ['Documents', 'Joindre des fichiers aux voyages'],
      ['Widgets', 'Convertisseur de devises et fuseaux horaires'],
    ],
    whatIs: "Qu'est-ce que TREK ?",
    whatIsDesc: 'Un planificateur de voyages auto-hébergé avec collaboration en temps réel, cartes interactives, connexion OIDC et mode sombre.',
    selfHost: 'Open source — ',
    selfHostLink: 'hébergez-le vous-même',
    close: 'Compris',
  },
  it: {
    titleBefore: 'Benvenuto su ',
    titleAfter: '',
    title: 'Benvenuto nella demo di TREK',
    description: 'Puoi visualizzare, modificare e creare viaggi. Tutte le modifiche vengono ripristinate automaticamente ogni ora.',
    resetIn: 'Prossimo ripristino tra',
    minutes: 'minuti',
    uploadNote: 'I caricamenti di file (foto, documenti, copertine) sono disabilitati in modalità demo.',
    fullVersionTitle: 'Inoltre nella versione completa:',
    features: [
      'Caricamento file (foto, documenti, copertine)',
      'Gestione chiavi API (Google Maps, meteo)',
      'Gestione utenti e permessi',
      'Backup automatici',
      'Gestione addon (attiva/disattiva)',
      'Single Sign-On OIDC / SSO',
    ],
    addonsTitle: 'Addon modulari (disattivabili nella versione completa)',
    addons: [
      ['Vacay', 'Pianificatore vacanze con calendario, festività e fusione'],
      ['Atlas', 'Mappa mondiale con paesi visitati e statistiche di viaggio'],
      ['Packing', 'Checklist per ogni viaggio'],
      ['Budget', 'Monitoraggio spese con suddivisione'],
      ['Documents', 'Allega file ai viaggi'],
      ['Widgets', 'Convertitore valute e fusi orari'],
    ],
    whatIs: "Cos'è TREK?",
    whatIsDesc: 'Un pianificatore di viaggi self-hosted con collaborazione in tempo reale, mappe interattive, login OIDC e modalità scura.',
    selfHost: 'Open source — ',
    selfHostLink: 'ospitalo tu stesso',
    close: 'Capito',
  },
  br: {
    titleBefore: 'Bem-vindo ao ',
    titleAfter: '',
    title: 'Bem-vindo à demo do TREK',
    description: 'Você pode visualizar, editar e criar viagens. Todas as alterações são redefinidas automaticamente a cada hora.',
    resetIn: 'Próxima redefinição em',
    minutes: 'minutos',
    uploadNote: 'O envio de arquivos (fotos, documentos, capas) está desabilitado no modo demo.',
    fullVersionTitle: 'Além disso, na versão completa:',
    features: [
      'Envio de arquivos (fotos, documentos, capas)',
      'Gerenciamento de chaves API (Google Maps, clima)',
      'Gerenciamento de usuários e permissões',
      'Backups automáticos',
      'Gerenciamento de addons (ativar/desativar)',
      'Login único OIDC / SSO',
    ],
    addonsTitle: 'Addons modulares (desativáveis na versão completa)',
    addons: [
      ['Vacay', 'Planejador de férias com calendário, feriados e fusão'],
      ['Atlas', 'Mapa mundial com países visitados e estatísticas de viagem'],
      ['Packing', 'Listas de verificação por viagem'],
      ['Budget', 'Rastreamento de gastos com divisão'],
      ['Documents', 'Anexar arquivos às viagens'],
      ['Widgets', 'Conversor de moedas e fusos horários'],
    ],
    whatIs: 'O que é TREK?',
    whatIsDesc: 'Um planejador de viagens auto-hospedado com colaboração em tempo real, mapas interativos, login OIDC e modo escuro.',
    selfHost: 'Open source — ',
    selfHostLink: 'hospede você mesmo',
    close: 'Entendi',
  },
  pl: {
    titleBefore: 'Witaj w ',
    titleAfter: '',
    title: 'Witaj w wersji demo TREK',
    description: 'Możesz przeglądać, edytować i tworzyć podróże. Wszystkie zmiany są automatycznie resetowane co godzinę.',
    resetIn: 'Następny reset za',
    minutes: 'minut',
    uploadNote: 'Przesyłanie plików (zdjęcia, dokumenty, okładki) jest wyłączone w trybie demo.',
    fullVersionTitle: 'Dodatkowo w pełnej wersji:',
    features: [
      'Przesyłanie plików (zdjęcia, dokumenty, okładki)',
      'Zarządzanie kluczami API (Google Maps, pogoda)',
      'Zarządzanie użytkownikami i uprawnieniami',
      'Automatyczne kopie zapasowe',
      'Zarządzanie dodatkam i (włącz/wyłącz)',
      'Logowanie jednorazowe OIDC / SSO',
    ],
    addonsTitle: 'Modułowe dodatki (dezaktywowalne w pełnej wersji)',
    addons: [
      ['Vacay', 'Planista urlopów z kalendarzem, świętami i fuzją'],
      ['Atlas', 'Mapa świata z odwiedzonymi krajami i statystykami podróży'],
      ['Packing', 'Listy kontrolne na podróż'],
      ['Budget', 'Śledzenie wydatków z podziałem'],
      ['Documents', 'Dołączanie plików do podróży'],
      ['Widgets', 'Przelicznik walut i strefy czasowe'],
    ],
    whatIs: 'Czym jest TREK?',
    whatIsDesc: 'Samodzielnie hostowany planista podróży z współpracą w czasie rzeczywistym, interaktywnymi mapami, logowaniem OIDC i trybem ciemnym.',
    selfHost: 'Open source — ',
    selfHostLink: 'hostuj samodzielnie',
    close: 'Rozumiem',
  },
  nl: {
    titleBefore: 'Welkom bij ',
    titleAfter: '',
    title: 'Welkom bij de TREK demo',
    description: 'Je kunt reizen bekijken, bewerken en aanmaken. Alle wijzigingen worden elk uur automatisch gereset.',
    resetIn: 'Volgende reset over',
    minutes: 'minuten',
    uploadNote: 'Het uploaden van bestanden (foto\'s, documenten, omslagen) is uitgeschakeld in de demomodus.',
    fullVersionTitle: 'Daarnaast in de volledige versie:',
    features: [
      "Bestanden uploaden (foto's, documenten, omslagen)",
      'API-sleutelbeheer (Google Maps, weer)',
      'Gebruikers- en rechtenbeheer',
      'Automatische back-ups',
      'Addon-beheer (in-/uitschakelen)',
      'OIDC / SSO single sign-on',
    ],
    addonsTitle: 'Modulaire addons (uitschakelbaar in volledige versie)',
    addons: [
      ['Vacay', 'Vakantieplannermet kalender, feestdagen en samenvoeging'],
      ['Atlas', 'Wereldkaart met bezochte landen en reisstatistieken'],
      ['Packing', 'Checklists per reis'],
      ['Budget', 'Uitgavenregistratie met splitsing'],
      ['Documents', 'Bestanden aan reizen koppelen'],
      ['Widgets', 'Valutaconverter en tijdzones'],
    ],
    whatIs: 'Wat is TREK?',
    whatIsDesc: 'Een zelf-gehoste reisplanner met realtime samenwerking, interactieve kaarten, OIDC-login en donkere modus.',
    selfHost: 'Open source — ',
    selfHostLink: 'zelf hosten',
    close: 'Begrepen',
  },
  hu: {
    titleBefore: 'Üdvözöl a ',
    titleAfter: '',
    title: 'Üdvözöl a TREK demo',
    description: 'Megtekinthetsz, szerkeszthetsz és létrehozhatsz utazásokat. Minden változtatás óránként automatikusan visszaáll.',
    resetIn: 'Következő visszaállítás',
    minutes: 'perc múlva',
    uploadNote: 'Fájlfeltöltés (fotók, dokumentumok, borítók) le van tiltva demó módban.',
    fullVersionTitle: 'Ezenkívül a teljes verzióban:',
    features: [
      'Fájlfeltöltés (fotók, dokumentumok, borítók)',
      'API-kulcskezelés (Google Maps, időjárás)',
      'Felhasználó- és jogosultságkezelés',
      'Automatikus biztonsági mentések',
      'Addon-kezelés (engedélyez/letilt)',
      'OIDC / SSO egyszeri bejelentkezés',
    ],
    addonsTitle: 'Moduláris kiegészítők (kikapcsolható a teljes verzióban)',
    addons: [
      ['Vacay', 'Nyaralástervező naptárral, ünnepnapokkal és összevonással'],
      ['Atlas', 'Világtérkép meglátogatott országokkal és utazási statisztikákkal'],
      ['Packing', 'Ellenőrzőlisták utazásonként'],
      ['Budget', 'Kiadáskövetés felosztással'],
      ['Documents', 'Fájlok csatolása utazásokhoz'],
      ['Widgets', 'Valutaváltó és időzónák'],
    ],
    whatIs: 'Mi az a TREK?',
    whatIsDesc: 'Saját tárhelyen üzemelő utazástervező valós idejű együttműködéssel, interaktív térképekkel, OIDC bejelentkezéssel és sötét móddal.',
    selfHost: 'Nyílt forráskód — ',
    selfHostLink: 'üzemeltesd magad',
    close: 'Értettem',
  },
  cs: {
    titleBefore: 'Vítejte v ',
    titleAfter: '',
    title: 'Vítejte v demo verzi TREK',
    description: 'Můžete prohlížet, upravovat a vytvářet cesty. Všechny změny se každou hodinu automaticky obnoví.',
    resetIn: 'Příští reset za',
    minutes: 'minut',
    uploadNote: 'Nahrávání souborů (fotografie, dokumenty, obálky) je v demoverzi zakázáno.',
    fullVersionTitle: 'Navíc v plné verzi:',
    features: [
      'Nahrávání souborů (fotografie, dokumenty, obálky)',
      'Správa API klíčů (Google Maps, počasí)',
      'Správa uživatelů a oprávnění',
      'Automatické zálohy',
      'Správa doplňků (zapnout/vypnout)',
      'Jednotné přihlášení OIDC / SSO',
    ],
    addonsTitle: 'Modulární doplňky (v plné verzi deaktivovatelné)',
    addons: [
      ['Vacay', 'Plánovač dovolené s kalendářem, svátky a sloučením'],
      ['Atlas', 'Mapa světa s navštívenými zeměmi a cestovními statistikami'],
      ['Packing', 'Kontrolní seznamy na cestu'],
      ['Budget', 'Sledování výdajů s rozdělením'],
      ['Documents', 'Připojení souborů k cestám'],
      ['Widgets', 'Měnový převodník a časová pásma'],
    ],
    whatIs: 'Co je TREK?',
    whatIsDesc: 'Vlastnoručně hostovaný plánovač cest s colaborací v reálném čase, interaktivními mapami, přihlášením OIDC a tmavým režimem.',
    selfHost: 'Open source — ',
    selfHostLink: 'hostujte sami',
    close: 'Rozumím',
  },
  ru: {
    titleBefore: 'Добро пожаловать в ',
    titleAfter: '',
    title: 'Добро пожаловать в демоверсию TREK',
    description: 'Вы можете просматривать, редактировать и создавать поездки. Все изменения автоматически сбрасываются каждый час.',
    resetIn: 'Следующий сброс через',
    minutes: 'минут',
    uploadNote: 'Загрузка файлов (фотографии, документы, обложки) отключена в режиме демо.',
    fullVersionTitle: 'Дополнительно в полной версии:',
    features: [
      'Загрузка файлов (фотографии, документы, обложки)',
      'Управление ключами API (Google Maps, погода)',
      'Управление пользователями и правами',
      'Автоматические резервные копии',
      'Управление аддонами (включить/выключить)',
      'Единый вход OIDC / SSO',
    ],
    addonsTitle: 'Модульные аддоны (отключаемые в полной версии)',
    addons: [
      ['Vacay', 'Планировщик отпуска с календарём, праздниками и объединением'],
      ['Atlas', 'Карта мира с посещёнными странами и статистикой путешествий'],
      ['Packing', 'Чек-листы для каждой поездки'],
      ['Budget', 'Отслеживание расходов с разделением'],
      ['Documents', 'Прикрепление файлов к поездкам'],
      ['Widgets', 'Конвертер валют и часовые пояса'],
    ],
    whatIs: 'Что такое TREK?',
    whatIsDesc: 'Самостоятельно размещаемый планировщик путешествий с совместной работой в реальном времени, интерактивными картами, входом OIDC и тёмной темой.',
    selfHost: 'Открытый исходный код — ',
    selfHostLink: 'разместите сами',
    close: 'Понятно',
  },
}

const featureIcons = [Upload, Key, Users, Database, Puzzle, Shield]
const addonIcons = [CalendarDays, Globe, ListChecks, Wallet, FileText, ArrowRightLeft]

export default function DemoBanner(): React.ReactElement | null {
  const [dismissed, setDismissed] = useState<boolean>(false)
  const [minutesLeft, setMinutesLeft] = useState<number>(59 - new Date().getMinutes())
  const { language } = useTranslation()
  const t = texts[language] || texts.en

  useEffect(() => {
    const interval = setInterval(() => setMinutesLeft(59 - new Date().getMinutes()), 10000)
    return () => clearInterval(interval)
  }, [])

  if (dismissed) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, overflow: 'auto',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    }} onClick={() => setDismissed(true)}>
      <div style={{
        background: 'white', borderRadius: 20, padding: '28px 24px 20px',
        maxWidth: 480, width: '100%',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        maxHeight: '90vh', overflow: 'auto',
      }} onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <img src="/icons/icon-dark.svg" alt="" style={{ width: 36, height: 36, borderRadius: 10 }} />
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827', display: 'flex', alignItems: 'center', gap: 5 }}>
            {t.titleBefore}<img src="/text-dark.svg" alt="TREK" style={{ height: 18 }} />{t.titleAfter}
          </h2>
        </div>

        <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6, margin: '0 0 12px' }}>
          {t.description}
        </p>

        {/* Timer + Upload note */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', gap: 6,
            background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 10, padding: '8px 10px',
          }}>
            <Clock size={13} style={{ flexShrink: 0, color: '#0284c7' }} />
            <span style={{ fontSize: 11, color: '#0369a1', fontWeight: 600 }}>
              {t.resetIn} {minutesLeft} {t.minutes}
            </span>
          </div>
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', gap: 6,
            background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '8px 10px',
          }}>
            <Upload size={13} style={{ flexShrink: 0, color: '#b45309' }} />
            <span style={{ fontSize: 11, color: '#b45309' }}>{t.uploadNote}</span>
          </div>
        </div>

        {/* What is TREK */}
        <div style={{
          background: '#f8fafc', borderRadius: 12, padding: '12px 14px', marginBottom: 16,
          border: '1px solid #e2e8f0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Map size={14} style={{ color: '#111827' }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: '#111827', display: 'flex', alignItems: 'center', gap: 4 }}>
              {t.whatIs}
            </span>
          </div>
          <p style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5, margin: 0 }}>{t.whatIsDesc}</p>
        </div>

        {/* Addons */}
        <p style={{ fontSize: 10, fontWeight: 700, color: '#374151', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Puzzle size={12} />
          {t.addonsTitle}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
          {t.addons.map(([name, desc], i) => {
            const Icon = addonIcons[i]
            return (
              <div key={name} style={{
                background: '#f8fafc', borderRadius: 10, padding: '8px 10px',
                border: '1px solid #f1f5f9',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <Icon size={12} style={{ flexShrink: 0, color: '#111827' }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#111827' }}>{name}</span>
                </div>
                <p style={{ fontSize: 10, color: '#94a3b8', margin: 0, lineHeight: 1.3, paddingLeft: 18 }}>{desc}</p>
              </div>
            )
          })}
        </div>

        {/* Full version features */}
        <p style={{ fontSize: 10, fontWeight: 700, color: '#374151', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Shield size={12} />
          {t.fullVersionTitle}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
          {t.features.map((text, i) => {
            const Icon = featureIcons[i]
            return (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#4b5563', padding: '4px 0' }}>
                <Icon size={13} style={{ flexShrink: 0, color: '#9ca3af' }} />
                <span>{text}</span>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div style={{
          paddingTop: 14, borderTop: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9ca3af' }}>
            <Github size={13} />
            <span>{t.selfHost}</span>
            <a href="https://github.com/mauriceboe/TREK" target="_blank" rel="noopener noreferrer"
              style={{ color: '#111827', fontWeight: 600, textDecoration: 'none' }}>
              {t.selfHostLink}
            </a>
          </div>
          <button onClick={() => setDismissed(true)} style={{
            background: '#111827', color: 'white', border: 'none',
            borderRadius: 10, padding: '8px 20px', fontSize: 12,
            fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}>
            {t.close}
          </button>
        </div>
      </div>
    </div>
  )
}
