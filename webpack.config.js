const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

// El sitio en vivo corre en Docker dentro de WSL (Ubuntu): la salida de dev se
// escribe directamente en su modules_v4 vía \\wsl.localhost. Se puede apuntar a
// otra instalación con la variable de entorno WEBTREES_MODULES_DIR.
const MODULES_DIR = process.env.WEBTREES_MODULES_DIR
  || '\\\\wsl.localhost\\Ubuntu\\home\\svelascs\\webtrees\\webtree-docker\\www\\myfamilytree\\modules_v4';

const DEV_OUTPUT  = path.join(MODULES_DIR, 'better-webtrees-forms', 'resources');
const PROD_OUTPUT = path.resolve(__dirname, 'dist/resources');
const LOCAL_OUTPUT = path.resolve(__dirname, 'resources');

const DEV_MODULE = path.join(MODULES_DIR, 'better-webtrees-forms');

module.exports = (env = {}) => {
  const isProd = process.env.NODE_ENV === 'production';
  const target = env.target || 'webtrees';
  const copyPatterns = [];

  let outputPath = DEV_OUTPUT;

  if (target === 'dist') {
    outputPath = PROD_OUTPUT;

    // Production: copy to dist/
    copyPatterns.push(
      { from: 'module.php',                    to: path.resolve(__dirname, 'dist/module.php') },
      { from: 'BetterWebtreesFormsModule.php', to: path.resolve(__dirname, 'dist/BetterWebtreesFormsModule.php') },
      { from: 'src/php',                        to: path.resolve(__dirname, 'dist/src/php') },
    );
  } else if (target === 'local') {
    outputPath = LOCAL_OUTPUT;
  } else {
    // Development: sync to local webtrees installation (myfamilytree/modules_v4)
    copyPatterns.push(
      { from: 'module.php',                    to: `${DEV_MODULE}/module.php`, force: true },
      { from: 'BetterWebtreesFormsModule.php', to: `${DEV_MODULE}/BetterWebtreesFormsModule.php`, force: true },
      { from: 'src/php',                        to: `${DEV_MODULE}/src/php`, force: true },
    );
  }

  return {
    mode: isProd ? 'production' : 'development',
    entry: {
      'better-webtrees-forms': './src/js/better-webtrees-forms.js',
    },
    devtool: isProd ? false : 'inline-source-map',
    output: {
      filename: 'js/[name].js',
      path: outputPath,
      clean: false,
    },
    plugins: [
      ...(copyPatterns.length > 0
        ? [
          new CopyPlugin({
            patterns: copyPatterns,
          }),
        ]
        : []),
      new MiniCssExtractPlugin({
        filename: 'css/[name].css',
      }),
    ],
    module: {
      rules: [
        {
          test: /\.m?js$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: ['@babel/preset-env'],
            },
          },
        },
        {
          test: /\.(sa|sc|c)ss$/,
          use: [
            MiniCssExtractPlugin.loader,
            'css-loader',
            'postcss-loader',
            'sass-loader',
          ],
        },
      ],
    },
  };
};
