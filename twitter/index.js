import got from "got";
import {PrismaClient} from "@prisma/client";
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

    static sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
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

    makeAPIRequest = async (method, url, searchParams = null, onErrorBody = null, raw=null) => {
        const request = this._createRequestFunction(method, url, searchParams)
        const catchCallback = async ({response: {headers, statusCode, body}}) => {
            if (statusCode === 429) {
                const remainingTime = (headers?.['x-rate-limit-reset'] * 1000) - Date.now()

                console.log(`>>> Waiting for ${Math.floor(remainingTime/1000/60)} minutes until rate limiting reset ...`)

                await TwitterOAuthClientBase.sleep(remainingTime)
                return await this.makeAPIRequest(method, url, searchParams)
            } else {
                return raw ? body : JSON.parse(onErrorBody || body)
            }
        }

        return raw ?
            await request.text().catch(catchCallback) :
            await request.json().catch(catchCallback)
    }

    getUser = async (id) => {
        return await this.makeAPIRequest(
            'GET',
            "https://api.twitter.com/1.1/users/show.json",
            {
                "user_id": id,
                "include_entities": true
            }
        )
    }

    getUserv2 = async (id) => {
        return await this.makeAPIRequest(
            'GET',
            `https://api.twitter.com/2/users/${id}`,
            {
                'expansions': 'pinned_tweet_id',
                'user.fields': 'created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,withheld'
            }
        )
    }

    get me() {
        return (async () => {
            return await this.makeAPIRequest(
                'GET',
                "https://api.twitter.com/1.1/account/verify_credentials.json",
                {
                    'include_email': true
                }
            )
        })();
    }

    get mev2() {
        return (async () => {
            return await this.makeAPIRequest(
                'GET',
                "https://api.twitter.com/2/users/me",
                {
                    'expansions': 'pinned_tweet_id',
                    'user.fields': 'created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,withheld'
                }
            )
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

        return querystring.parse(await this.makeAPIRequest(
            'POST',
            "https://api.twitter.com/oauth/request_token",
            {
                "oauth_callback": this.callback
            },
            null,
            true
        ))

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
        return prisma.twitterOAuthAccessToken.findFirst({
            where: {
                userId: userId
            },
            orderBy: {
                timestamp: "desc"
            }
        })
    }

    userContext = (token, tokenSecret) => new TwitterOAuthClientBase({
        oauthConsumerKey: this.oauthConsumerKey,
        oauthConsumerSecret: this.oauthConsumerSecret,
        oauthToken: token,
        oauthTokenSecret: tokenSecret
    })

}