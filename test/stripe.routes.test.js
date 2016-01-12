/**
 * Dependencies.
 */

var expect = require('chai').expect;
var request = require('supertest');
var async = require('async');
var nock = require('nock');
var config = require('config');
var _ = require('lodash');
var chance = require('chance').Chance();
var sinon = require('sinon');

var app = require('../index');
var utils = require('../test/utils.js')();
var models = app.set('models');

/**
 * Mock data
 */

var stripeMock = require('./mocks/stripe');
var userData = utils.data('user1');
var groupData = utils.data('group1');

describe('stripe.routes.test.js', function() {
  var nocks = {};

  var user;
  var card;
  var group;
  var host;
  var application;

  beforeEach(function(done) {
    utils.cleanAllDb(function(e, app) {
      application = app;
      done();
    });
  });

  // Create a user.
  beforeEach(function(done) {
    models.User.create(userData).done(function(e, u) {
      expect(e).to.not.exist;
      user = u;
      done();
    });
  });

  // Create a group.
  beforeEach(function(done) {
    request(app)
      .post('/groups')
      .set('Authorization', 'Bearer ' + user.jwt(application))
      .send({
        group: _.extend({}, groupData, {isHost: true}),
        role: 'admin'
      })
      .expect(200)
      .end(function(e, res) {
        expect(e).to.not.exist;
        host = res.body;

        request(app)
          .post('/groups')
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .send({
            group: _.extend({}, groupData, {isHost: false}),
            role: 'admin'
          })
          .expect(200)
          .end(function(e, res) {
            expect(e).to.not.exist;
            group = res.body;
            done();
          });
      });
  });

  afterEach(function() {
    nock.cleanAll();
  });

  describe('authorize', function() {
    it('should return an error if the user is not logged in', function(done) {
      request(app)
        .get('/groups/' + group.id + '/stripe/authorize')
        .send()
        .expect(401)
        .end(done);
    });

    it('should fail is the group is not a host', function(done) {
      request(app)
        .get('/groups/' + group.id + '/stripe/authorize')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .send()
        .expect(400, {
          error: {
            code: 400,
            type: 'bad_request',
            message: 'Group is not a host.'
          }
        })
        .end(done);
    });

    it('should redirect to stripe', function(done) {
      request(app)
        .get('/groups/' + host.id + '/stripe/authorize')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .expect(302) // redirect
        .end(function(e, res) {
          expect(e).to.not.exist;

          var redirectUrl = res.headers.location;
          expect(redirectUrl).to.contain('https://connect.stripe.com/oauth/authorize')
          expect(redirectUrl).to.contain('state=' + host.id)
          done();
        });
    });
  });

  describe('callback', function() {
    var stripeResponse = {
      access_token: 'sk_test_123',
      refresh_token: 'rt_123',
      token_type: 'bearer',
      stripe_publishable_key: 'pk_test_123',
      stripe_user_id: 'acct_123',
      scope: 'read_write'
    };

    beforeEach(function() {
      nock('https://connect.stripe.com')
      .post('/oauth/token', {
        grant_type: 'authorization_code',
        client_id: config.stripe.clientId,
        client_secret: config.stripe.secret,
        code: 'abc'
      })
      .reply(200, stripeResponse);
    });

    afterEach(function() {
      nock.cleanAll();
    });

    it('should fail if the state is empty', function(done) {
      request(app)
        .get('/stripe/oauth/callback')
        .expect(400)
        .end(done);
    });

    it('should fail if the group does not exist', function(done) {
      request(app)
        .get('/stripe/oauth/callback?state=123412312')
        .expect(400, {
          error: {
            code: 400,
            type: 'bad_request',
            message: 'Group does not exist'
          }
        })
        .end(done);
    });

    it('should set a stripeAccount', function(done) {
      var url = '/stripe/oauth/callback?state=' + host.id + '&code=abc';

      async.auto({
        request: function(cb) {
          request(app)
            .get(url)
            .expect(200)
            .end(cb);
        },

        checkStripeAccount: ['request', function(cb) {
          models.StripeAccount.findAndCountAll({})
            .done(function(e, res) {
              expect(e).to.not.exist;
              expect(res.count).to.be.equal(1);
              var account = res.rows[0];
              expect(account).to.have.property('accessToken', stripeResponse.access_token);
              expect(account).to.have.property('refreshToken', stripeResponse.refresh_token);
              expect(account).to.have.property('tokenType', stripeResponse.token_type);
              expect(account).to.have.property('stripePublishableKey', stripeResponse.stripe_publishable_key);
              expect(account).to.have.property('stripeUserId', stripeResponse.stripe_user_id);
              expect(account).to.have.property('scope', stripeResponse.scope);
              cb(null, account);
            });
        }],

        checkGroup: ['checkStripeAccount', function(cb, results) {
          models.Group.findAndCountAll({
            where: {
              StripeAccountId: results.checkStripeAccount.id
            }
          })
          .done(function(e, res) {
            expect(e).to.not.exist;
            expect(res.count).to.be.equal(1);
            var group = res.rows[0];
            expect(group.id).to.be.equal(host.id);
            cb();
          });
        }]
      }, done);

    });
  });

});