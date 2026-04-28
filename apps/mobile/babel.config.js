module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // Legacy decorators — required by @nozbe/watermelondb.
  plugins: [
    ['@babel/plugin-proposal-decorators', { legacy: true }],
    ['@babel/plugin-transform-class-properties', { loose: true }],
  ],
};
