import got from "got";
import {PrismaClient} from "@prisma/client";
import pkg from 'lodash';
import crypto from "crypto";
import querystring from "querystring";
import {uuid} from 'uuidv4'
const prisma = new PrismaClient();

export class TwitterOAuthClientBase {
    constructor({
                    oauthConsumerKey,
                    oauthSignatureMethod = 'HMAC-SHA1',
                    oauthToken,
                    oauthVersion = '1.0',
                    oauthConsumerSecret,
                    oauthTokenSecret
                }) {
        this.oauthConsumerKey = oauthConsumerKey
        this.oauthConsumerSecret = oauthConsumerSecret
        this.oauthToken = oauthToken
        this.oauthTokenSecret = oauthTokenSecret
        this.oauthVersion = oauthVersion
        this.oauthSignatureMethod = oauthSignatureMethod
    }

    createOAuthSignature = (
        {
            method,
            url,
            queryString = "",
            oauthNonce = "",
            oauthTimestamp = 0,
        }
    ) => {

        if (!oauthNonce) {
            // oauthNonce = crypto.randomBytes(32).toString('base64')
            oauthNonce = uuid()
        }

        if (!oauthTimestamp) {
            oauthTimestamp = Math.ceil(Date.now() / 1000)
        }

        const parameterString =
            TwitterOAuthClient.sortQueryString(
                `${queryString}&oauth_consumer_key=${this.oauthConsumerKey}&oauth_nonce=${oauthNonce}&oauth_signature_method=${this.oauthSignatureMethod}&oauth_timestamp=${oauthTimestamp}&oauth_token=${this.oauthToken}&oauth_version=${this.oauthVersion}`
            )

        const signatureBaseString = encodeURIComponent(method.toUpperCase()) + "&" + encodeURIComponent(url) + "&" + encodeURIComponent(parameterString)

        const signingKey = encodeURIComponent(this.oauthConsumerSecret) + "&" + encodeURIComponent(this.oauthTokenSecret)

        return crypto.createHmac('sha1', signingKey).update(signatureBaseString).digest('base64')
    }

    createOAuthHeaderString = (
        {
            method,
            url,
            queryString = "",
            oauthNonce = "",
            oauthTimestamp = 0,
        }
    ) => {
        if (!oauthNonce) {
            // oauthNonce = crypto.randomBytes(32).toString('base64')
            oauthNonce = uuid()
        }

        if (!oauthTimestamp) {
            oauthTimestamp = Math.ceil(Date.now() / 1000)
        }

        const _components = {
            oauth_consumer_key: this.oauthConsumerKey,
            oauth_nonce: oauthNonce,
            oauth_signature: this.createOAuthSignature({
                method: method,
                url: url,
                queryString: queryString,
                oauthNonce: oauthNonce,
                oauthTimestamp: oauthTimestamp
            }),
            oauth_signature_method: this.oauthSignatureMethod,
            oauth_timestamp: oauthTimestamp,
            oauth_token: this.oauthToken,
            oauth_version: this.oauthVersion
        }

        return (
            'OAuth ' +
            Object.entries(_components).map(
                ([key, value]) => `${encodeURIComponent(key)}="${encodeURIComponent(value)}"`
            ).join(', ')
        )
    }

    _createRequestFunction = (method, url, searchParams = null) => {
        return got({
            method: method,
            url: url,
            ...(searchParams ? {
                searchParams: searchParams
            } : {}),
            headers: {
                'Authorization': this.createOAuthHeaderString({
                    method: method,
                    url: url,
                    ...(searchParams ? {
                        queryString: querystring.stringify(
                            searchParams,
                            null,
                            null,
                            {
                                encodeURIComponent: string => string
                            }
                        )
                    } : {})
                })
            }
        })
    }

    getUser = async (id) => {
        const response = await this._createRequestFunction(
            'GET',
            "https://api.twitter.com/1.1/users/show.json",
            {
                "user_id": id,
                "include_entities": true
            }
        ).catch(({response}) => {
            Promise.resolve(JSON.parse(response?.body))
        })

        return JSON.parse(response?.body)
    }

    getUserv2 = async (id) => {
        const response = await this._createRequestFunction(
            'GET',
            `https://api.twitter.com/2/users/${id}`,
            {
                'expansions': 'pinned_tweet_id',
                'user.fields': 'created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,withheld'
            }
        ).catch(({response}) => {
            Promise.resolve(JSON.parse(response?.body))
        })

        return JSON.parse(response?.body)
    }

    get me() {
        return (async () => {
            const response = await this._createRequestFunction(
                'GET',
                "https://api.twitter.com/1.1/account/verify_credentials.json",
                {
                    'include_email': true
                }
            ).catch(({response}) => {
                Promise.resolve(JSON.parse(response?.body))
            })

            return JSON.parse(response?.body)
        })();
    }

    get mev2() {
        return (async () => {
            const response = await this._createRequestFunction(
                'GET',
                "https://api.twitter.com/2/users/me",
                {
                    'expansions': 'pinned_tweet_id',
                    'user.fields': 'created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,withheld'
                }
            ).catch(({response}) => {
                Promise.resolve(JSON.parse(response?.body))
            })

            return JSON.parse(response?.body)
        })();
    }
}

export class TwitterOAuthClient extends TwitterOAuthClientBase {
    constructor({callback, ...props}) {
        super(props)
        this.callback = callback
        this._store = {}
    }

    static sortQueryString = (queryString) => {
        const _parsedQueryString = querystring.parse(queryString)
        return querystring.stringify(
            Object.fromEntries(
                Object.keys(_parsedQueryString)
                    .sort()
                    .map(v => [v, _parsedQueryString[v]])
            )
        )
    }

    getOauthRequestToken = async () => {

        const response = await this._createRequestFunction(
            'POST',
            "https://api.twitter.com/oauth/request_token",
            {
                "oauth_callback": this.callback
            }
        ).catch(({response}) => {
            console.log(response.body)
            Promise.resolve(response.body)
        })

        return querystring.parse(response?.body)
    }

    generateAuthURL = async () => {
        const {oauth_token, oauth_token_secret, oauth_callback_confirmed} = await this.getOauthRequestToken()

        if (oauth_callback_confirmed) {
            this._store[oauth_token] = oauth_token_secret

            return 'https://api.twitter.com/oauth/authorize?' + querystring.stringify({
                oauth_token: oauth_token
            })
        }
    }

    getAccessToken = async (oauthToken, oauthVerifier) => {
        return querystring.parse(
            (
                await got.post(
                    'https://api.twitter.com/oauth/access_token',
                    {
                        searchParams: {
                            'oauth_token': oauthToken,
                            'oauth_verifier': oauthVerifier
                        }
                    }
                ).catch(({response})=>{
                    Promise.resolve(response?.body)
                })
            )?.body
        )
    }

    static getStoredAccessToken = async (userId) => {
        const token = await prisma.twitterOAuthAccessToken.findFirst({
            where: {
                userId: userId
            },
            orderBy: {
                timestamp: "desc"
            }
        })

        return token
    }

    userContext = (token, tokenSecret) => new TwitterOAuthClientBase({
        oauthConsumerKey: this.oauthConsumerKey,
        oauthConsumerSecret: this.oauthConsumerSecret,
        oauthToken: token,
        oauthTokenSecret: tokenSecret
    })

}