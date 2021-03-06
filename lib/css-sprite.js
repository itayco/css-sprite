'use strict';

var async = require('async');
var through2 = require('through2');
var lodash = require('lodash');
var path = require('path');
var json2css = require('json2css');
var File = require('vinyl');
var imageinfo = require('imageinfo');
var layout = require('layout');
var replaceExtension = require('./replace-extension');
var lwip = require('lwip');
var Color = require('color');

// json2css template
json2css.addTemplate('sprite', require(path.join(__dirname, 'templates/sprite.js')));

module.exports = function (opt) {
  opt = lodash.extend({}, {name: 'sprite', format: 'png', margin: 4, processor: 'css', cssPath: '../images', orientation: 'vertical', sort: true}, opt);
  opt.styleExtension = (opt.processor === 'stylus') ? 'styl' : opt.processor;
  var layoutOrientation = opt.orientation === 'vertical' ? 'top-down' : opt.orientation === 'horizontal' ? 'left-right' : 'binary-tree';
  var layer = layout(layoutOrientation, {'sort': opt.sort});
  var nonRetinaLayer = layout(layoutOrientation, {'sort': opt.sort});

  if (opt.opacity === 0 && opt.format === 'jpg') {
    opt.opacity = 1;
  }

  var color = new Color(opt.background);
  opt.color = color.rgbArray();
  opt.color.push(opt.opacity);

  function queue (file, img) {
    var spriteName = replaceExtension(file.relative, '').replace(/\/|\\|\ /g, '-');

    var layerObj = layer;
    var margin = 2 * opt.margin;

    if (opt.nonRetinaFilesProvided && spriteName.indexOf('@2x') === -1) {
      layerObj = nonRetinaLayer;
      margin = opt.margin;
    }

    layerObj.addItem({
      height: img.height() + margin,
      width: img.width() + margin,
      meta: {
        name: spriteName,
        img: img,
        image: opt.cssPath + '/' + opt.name
      }
    });
  }

  function queueImages (file, enc, cb) {
    if (file.isNull()) {
      cb();
      return; // ignore
    }

    if (file.isStream()) {
      cb(new Error('Streaming not supported'));
      return; // ignore
    }
    if (imageinfo(file.contents)) {
      lwip.open(file.contents, imageinfo(file.contents).format.toLowerCase(), function(err, img) {
        if (!err) {
          queue(file, img);
          cb();
        }
        else {
          console.log('Ignoring ' + file.relative + ' -> ' + err.toString());
          cb();
        }
      });
    }
    else {
      console.log('Ignoring ' + file.relative + ' -> no image info');
      cb();
    }
  }

  function createCanvas (layerInfo, factor, cb) {
    lwip.create(layerInfo.width, layerInfo.height, opt.color, function (err, image) {
      async.eachSeries(layerInfo.items, function (sprite, callback) {
        image.paste(sprite.x + opt.margin * factor, sprite.y + opt.margin * factor, sprite.meta.img, callback);
      }, function () {
        cb(image);
      });
    });
  }

  function createNonRetinaCanvas (retinaCanvas, cb) {
    var width = Math.floor(retinaCanvas.width() / 2);
    var height = Math.floor(retinaCanvas.height() / 2);
    retinaCanvas.clone(function(err, clone){
      // tell lwip to use the 'grid' interpolation method when resizing - it makes the resized image look much better
      clone.resize(width, height, 'grid', function (err, image) {
        cb(image);
      });
    });
  }

  function createStyle (layerInfo, sprite, retinaSprite) {
    var sprites = [];
    lodash.forEach(layerInfo.items, function (sprite) {
      sprites.push({
        'name': sprite.meta.name.replace('@2x', ''),
        'x': sprite.x + opt.margin,
        'y': sprite.y + opt.margin,
        'width': sprite.width - opt.margin * 2,
        'height': sprite.height - opt.margin * 2,
        'total_width': layerInfo.width,
        'total_height': layerInfo.height,
        'image': sprite.meta.image
      });
    });

    if (retinaSprite) {
      sprites.unshift({
        name: retinaSprite.relative.replace('@2x', ''),
        type: 'retina',
        image: (!opt.base64) ? path.join(opt.cssPath, retinaSprite.relative).replace(/\\/g, '/') : 'data:' + imageinfo(retinaSprite.buffer).mimeType + ';base64,' + retinaSprite.buffer.toString('base64'),
        total_width: sprite.canvas.width(),
        total_height: sprite.canvas.height()
      });

      lodash.forEach(sprites, function (sprite, i) {
        sprites[i].x = Math.floor(sprite.x / 2);
        sprites[i].y = Math.floor(sprite.y / 2);
        sprites[i].width = Math.floor(sprite.width / 2);
        sprites[i].height = Math.floor(sprite.height / 2);
      });
    }

    sprites.unshift({
      name: sprite.relative,
      type: 'sprite',
      image: (!opt.base64) ? path.join(opt.cssPath, sprite.relative).replace(/\\/g, '/') : 'data:' + imageinfo(sprite.buffer).mimeType + ';base64,' + sprite.buffer.toString('base64'),
      total_width: sprite.canvas.width,
      total_height: sprite.canvas.height
    });

    return json2css(sprites, {'format': 'sprite', formatOpts: {'cssClass': opt.prefix, 'processor': opt.processor, 'template': opt.template}});
  }

  function createSprite (cb) {
    var _this = this;
    var layerInfo = layer.export();
    if (opt.nonRetinaFilesProvided) {
        var nonRetinaLayerInfo = nonRetinaLayer.export();
    }
    var sprite, nonRetinaSprite, style;
    if (layerInfo.items.length === 0) {
      cb();
      return; // ignore
    }

    async.waterfall([
      function (callback) {
        createCanvas(layerInfo, 1, function (canvas) {
          sprite = {
            base: opt.out,
            relative: opt.name + '.' + opt.format,
            path: path.join(opt.out, opt.name + '.' + opt.format),
            canvas: canvas
          };
          callback(null, sprite);
        });
      },
      function (sprite, callback) {
        if (opt.retina) {
          sprite.path = replaceExtension(sprite.path, '') + '@2x.' + opt.format;
          sprite.relative = replaceExtension(sprite.relative, '') + '@2x.' + opt.format;

          if (opt.nonRetinaFilesProvided) {
            createCanvas(nonRetinaLayerInfo, 0.5, function (canvas) {
              nonRetinaSprite = {
                base: opt.out,
                relative: opt.name + '.' + opt.format,
                path: path.join(opt.out, opt.name + '.' + opt.format),
                canvas: canvas
              };
              callback(null, sprite, nonRetinaSprite);
            });
          }
          else {
            createNonRetinaCanvas(sprite.canvas, function (canvas) {
              nonRetinaSprite = {
                base: opt.out,
                relative: opt.name + '.' + opt.format,
                path: path.join(opt.out, opt.name + '.' + opt.format),
                canvas: canvas
              };
              callback(null, sprite, nonRetinaSprite);
            });
          }
        }
        else {
          callback(null, sprite, null);
        }
      },
      function (sprite, nonRetinaSprite, callback) {
        if (nonRetinaSprite) {
          nonRetinaSprite.canvas.toBuffer(opt.format, {}, function (err, buf) {
            nonRetinaSprite.buffer = buf;
            callback(null, sprite, nonRetinaSprite);
          });
        }
        else {
          callback(null, sprite, nonRetinaSprite);
        }
      },
      function (sprite, nonRetinaSprite, callback) {
        sprite.canvas.toBuffer(opt.format, {}, function (err, buf) {
          sprite.buffer = buf;
          callback(null, sprite, nonRetinaSprite);
        });
      },
      function (sprite, nonRetinaSprite, callback) {
        if (!opt.base64) {
          if (nonRetinaSprite) {
            _this.push(new File({
              base: nonRetinaSprite.base,
              path: nonRetinaSprite.path,
              contents: nonRetinaSprite.buffer
            }));
          }
          _this.push(new File({
            base: sprite.base,
            path: sprite.path,
            contents: sprite.buffer
          }));
        }
        callback(null, sprite, nonRetinaSprite);
      },
      function (sprite, nonRetinaSprite, callback) {
        if (opt.style || opt.base64) {
          style = opt.retina ? createStyle(layerInfo, nonRetinaSprite, sprite) : createStyle(layerInfo, sprite);
          _this.push(new File({
            base: !opt.base64 ? path.dirname(opt.style) : opt.out,
            path: opt.style ? opt.style : path.join(opt.out, replaceExtension(opt.name, '.' + opt.styleExtension)),
            contents: new Buffer(style)
          }));
        }
        callback(null);
      }
    ], function () {
      cb();
    });
  }

  return through2.obj(queueImages, createSprite);
};
