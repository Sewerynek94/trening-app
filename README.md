# Trening — obecność i konspekty (aplikacja na telefon)

Darmowa aplikacja PWA (instaluje się z przeglądarki na ekran główny Androida i iPhone'a, działa offline):

- **Lista obecności** — treningi z datą, grupą i tematem; dla każdego zawodnika jeden dotyk:
  **O**becny / **S**późniony / **U**sprawiedliwiony / **N**ieobecny, przyciski „Wszyscy obecni” i „Reszta nieobecna”.
- **Zawodnicy i grupy** — dodawanie pojedynczo lub całą listą (wklej imiona, jedno w linii).
- **Konspekty** — biblioteka plików PDF, Word (.docx), Markdown, TXT, HTML i zdjęć; podgląd w aplikacji,
  dołączanie konspektu do treningu. Na Androidzie można „Udostępnić” plik z Dysku Google prosto do aplikacji.
- **Kalendarz** — mecze, turnieje (także kilkudniowe) i treningi w widoku miesiąca; godzina, zbiórka, miejsce (link do Map Google), przeciwnik, wynik; lista powołanych z wysyłaniem np. na grupę rodziców; eksport do Kalendarza Google/Apple (.ics).
- **Statystyki** — frekwencja każdego zawodnika (30 dni / miesiąc / sezon / wszystko), historia, eksport CSV do Excela/Arkuszy.
- **Kopia zapasowa** — eksport/import wszystkich danych (z konspektami) do jednego pliku .json.

Dane są przechowywane wyłącznie na telefonie (IndexedDB) — nic nie trafia na serwer.

## W czym tworzyć konspekty

Najlepsze darmowe opcje:

1. **Dokumenty Google** (polecane) — działa w telefonie i na komputerze, pliki są w chmurze.
   Otwórz `szablony/konspekt-szablon.docx` w Dokumentach Google, uzupełniaj, a potem
   *Plik → Pobierz → PDF* (albo na Androidzie w Dysku: *⋮ → Udostępnij → Trening*).
2. **LibreOffice Writer** — darmowy pakiet biurowy na komputer; zapisuj konspekt jako PDF lub .docx.
3. Dowolny edytor Markdown (np. Obsidian) — szablon `szablony/konspekt-szablon.md`.

Pliki .odt/.doc zapisz jako PDF lub .docx — te formaty aplikacja otwiera bezpośrednio.

## Uruchomienie / publikacja

Aplikacja to statyczne pliki — nie wymaga budowania.

- **GitHub Pages:** *Settings → Pages → Source: GitHub Actions*. Workflow `.github/workflows/pages.yml`
  publikuje aplikację po każdym pushu do `main`. Adres: **https://sewerynek94.github.io/trening-app/**
- **Lokalnie:** `python3 -m http.server 8000` w tym folderze i otwórz `http://localhost:8000`.

Instalacja na telefonie: Android/Chrome → *⋮ → Zainstaluj aplikację*; iPhone/Safari → *Udostępnij → Do ekranu początkowego*.

## Struktura

```
index.html, styles.css      interfejs
app.js                      widoki: treningi, obecność, zawodnicy, konspekty, statystyki, ustawienia
db.js                       zapis danych w IndexedDB
viewer.js                   podgląd PDF / DOCX / MD / TXT / HTML / obrazów
sw.js                       tryb offline + odbieranie udostępnionych plików
vendor/                     pdf.js 4.10, mammoth 1.13, marked 18 (lokalne kopie, działają offline)
szablony/                   szablon konspektu (.docx i .md)
```

Po zmianie plików aplikacji podnieś wersję `CACHE` w `sw.js`, żeby telefony pobrały nową wersję.
