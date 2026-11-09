# textlint-lsp

[textlint](https://textlint.github.io/) を LSP（Language Server Protocol）で使えるようにするサーバーです。Zed、Neovim など LSP 対応エディタで日本語文章校正ができます。

## インストール

```bash
npm install -g textlint-lsp
```

## 使い方

プロジェクトに textlint とルールをセットアップしてください。

```bash
npm install --save-dev textlint @textlint/markdown
npm install --save-dev @textlint-ja/no-synonyms prh
```

`.textlintrc.json` を作成：

```json
{
  "plugins": { "@textlint/markdown": true },
  "rules": {
    "@textlint-ja/no-synonyms": true,
    "prh": { "rulePaths": ["prh.yml"] }
  }
}
```

### Zed

[zed-textlint.zip](https://yasutakeyohei.com/zed-textlint.zip) をダウンロードし、Dev Extension としてインストールしてください。

1. ダウンロードして展開
2. `Ctrl+Shift+P` → `zed: install dev extension` → 展開したフォルダを指定

### JetBrains IDEs（IntelliJ IDEAなど）

[LSP4IJ](https://plugins.jetbrains.com/plugin/23257-lsp4ij)プラグインを使用します。

1. LSP4IJプラグインをインストール\
  **Settings > Plugins > marketplace** で `LSP4IJ` を検索してインストール
2. Language Serverの設定\
  **Settings > Languages & Frameworks > Language Servers > +** で textlint-lsp の設定を追加します
   1. Serverタブ
       - Name: 任意
       - Command: `textlint-lsp`
           - パスが解決できず実行できない環境では `/opt/homebrew/bin/textlint-lsp` のようにフルパスを指定します。パスは `which textlint-lsp` で確認できます
   2. Mappingタブ
       - **File name patterns** にパターンを追加
           - Markdownの場合、`*.md`
           - `articles/*.re` のようなパス指定はできません。パスによるフィルタリングには`.textlintignore`ファイルを使用してください

> [!IMPORTANT]\
> LSP4IJを使用する場合、textlint-lspはグローバルインストール（`npm install -g`）してください。
> LSP4IJのLanguage Server設定はコンピューター単位で保持されるため、全プロジェクトで有効になります。
> textlint-lspを特定のプロジェクトにだけインストールして使用すると、インストールしていないプロジェクトでMarkdownファイルを開いたときにtextlint-lspが見つからず起動に失敗します。起動失敗が20回続くと、LSP4IJはそのLanguage Serverを停止します。

## できること

- 文字入力のたびに自動校正
- 波線で問題箇所を表示
- `Ctrl+.` で修正候補を表示・適用
- ルール単位の無効化

## ライセンス

MIT
