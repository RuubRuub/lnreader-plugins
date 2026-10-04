import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { defaultCover } from '@libs/defaultCover';

// Based on Dakrataz/my-lnreader-plugins. The website itself sits behind a
// Cloudflare challenge, but everything comes from the open StoryWave JSON API,
// so no HTML scraping or WebView is needed.
const API = 'https://api.mystorywave.com/story-wave-backend/api/v1/content';

type Book = {
  id: number;
  title: string;
  coverImgUrl?: string;
  authorPseudonym?: string;
  genreName?: string;
  synopsis?: string;
};

type Chapter = {
  id: number;
  title: string;
  chapterOrder: number;
  publishTime: number;
};

class BotiTranslation implements Plugin.PluginBase {
  id = 'botitranslation';
  name = 'Boti Translation';
  icon = 'src/en/botitranslation/icon.png';
  site = 'https://www.botitranslation.com';
  version = '1.0.0';

  headers = {
    'lang': 'en_US',
    'site-domain': 'www.botitranslation.com',
    'Origin': this.site,
    'Referer': this.site + '/',
  };

  async api(path: string) {
    const res = await fetchApi(API + path, { headers: this.headers });
    return (await res.json()).data;
  }

  toItem = (book: Book): Plugin.NovelItem => ({
    name: book.title,
    path: book.id.toString(),
    cover: book.coverImgUrl || defaultCover,
  });

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({
      pageNumber: pageNo.toString(),
      pageSize: '20',
    });
    if (filters) {
      for (const key of ['type', 'genre', 'withinDay'] as const) {
        if (filters[key].value) params.append(key, filters[key].value);
      }
    }
    const data = await this.api('/books?' + params.toString());
    return (data.list || []).map(this.toItem);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const book = await this.api('/books/' + novelPath);

    const chapters: Plugin.ChapterItem[] = [];
    for (let page = 1; ; page++) {
      const data = await this.api(
        `/chapters/page?sortDirection=ASC&bookId=${novelPath}&pageNumber=${page}&pageSize=100`,
      );
      const list: Chapter[] = data.list || [];
      for (const chap of list) {
        chapters.push({
          name: chap.title,
          path: chap.id.toString(),
          releaseTime: chap.publishTime
            ? new Date(chap.publishTime).toISOString()
            : null,
          chapterNumber: chap.chapterOrder,
        });
      }
      // A short page is the last one; don't rely on the API returning empty.
      if (list.length < 100) break;
    }

    // The API's numeric status codes don't map cleanly to ongoing/completed
    // (a book publishing daily reports status 1), so status is left unset.
    return {
      ...this.toItem(book),
      author: book.authorPseudonym,
      genres: book.genreName,
      summary: book.synopsis,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const chapter = await this.api('/chapters/' + chapterPath);
    return chapter.content || '';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const data = await this.api(
      `/books/search?keyWord=${encodeURIComponent(searchTerm)}&pageNumber=${pageNo}&pageSize=50`,
    );
    return (data.list || []).map(this.toItem);
  }

  resolveUrl = (path: string, isNovel?: boolean) =>
    this.site + (isNovel ? '/book/' : '/chapter/') + path;

  filters = {
    type: {
      label: 'Category',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Original', value: 'original' },
        { label: 'Translation', value: 'translation' },
      ],
      type: FilterTypes.Picker,
    },
    genre: {
      label: 'Genre',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Fantasy', value: '1' },
        { label: 'Sci-fi', value: '2' },
        { label: 'Sports', value: '3' },
        { label: 'Urban', value: '4' },
        { label: 'Eastern Fantasy', value: '5' },
        { label: 'Horror&Thriller', value: '6' },
        { label: 'Video Game', value: '7' },
        { label: 'History', value: '8' },
        { label: 'War', value: '9' },
        { label: 'Urban Romance', value: '10' },
        { label: 'Fantasy Romance', value: '11' },
        { label: 'Historical Romance', value: '12' },
        { label: 'Teen', value: '13' },
        { label: 'LGBT+', value: '14' },
        { label: 'Others', value: '16' },
      ],
      type: FilterTypes.Picker,
    },
    withinDay: {
      label: 'Last Update',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Within 3 Days', value: '3' },
        { label: 'Within 7 Days', value: '7' },
        { label: 'Within 15 Days', value: '15' },
        { label: 'Within 30 Days', value: '30' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new BotiTranslation();
