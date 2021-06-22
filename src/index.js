process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://d8d598e7826848ee8c13052d71adb6f4@sentry.cozycloud.cc/113'

const {
  BaseKonnector,
  requestFactory,
  signin,
  saveBills,
  log,
  scrape
} = require('cozy-konnector-libs')
const request = requestFactory({
  //  debug: true,
  cheerio: false,
  json: false,
  jar: true
})
const crypto = require('crypto')
const stream = require('stream')
const cheerio = require('cheerio')

const BASE_URL = 'https://api.lamutuellegenerale.fr'
const API_KEY = 'l7xx7e96b9de59df491a8d4c79be999e7c87'
const OIDC_CLIENT_ID = '066e0672-4b28-422d-aa44-ef42d0aad64a'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  const token = await authenticate(fields.login, fields.password)
  token.golden_id = JSON.parse(atob(token.id_token.split('.')[1])).sub[0].id
  log('info', 'Successfully logged in')
  log('debug', token, 'Token')
  const identity = await getIdentity(token)
  await this.saveIdentity(identity, fields.login)

  // log('info', 'Fetching the list of refunds')
  // const $ = await request(`${BASE_URL}/espaceadherent/V1/mesremboursements/`, {
  //   json: true,
  //   headers: {
  //     'api-key': API_KEY,
  //     Authorization: `${token.token_type} ${token.access_token}`,
  //     idPersonneUtilisateur: token.golden_id,
  //     appRequestCode: 'EspaceAdherent'
  //   }
  // })

  // log('info', $)

  const bill = {
    // fileurl: `${BASE_URL}/espaceadherent/V1/mesremboursements/edition?debutPeriode=2021-04-01&finPeriode=2021-04-30&tri=DATE_PAIEMENT&mock=false`,
    fetchFile: async function(d) {
      // filestream: async function(d) {
      log('info', 'Fetching file for id: ' + d.id)
      // Prepare the store to fetch the next bill
      return request(
        `${BASE_URL}/espaceadherent/V1/mesremboursements/edition?debutPeriode=2021-04-01&finPeriode=2021-04-30&tri=DATE_PAIEMENT&mock=false`,
        {
          json: true,
          form: {
            debutPeriode: '2021-04-01',
            finPeriode: '2021-04-30',
            tri: 'DATE_PAIEMENT',
            mock: 'false'
          },
          headers: {
            'api-key': API_KEY,
            Authorization: `${token.token_type} ${token.access_token}`,
            idPersonneUtilisateur: token.golden_id,
            appRequestCode: 'EspaceAdherent'
          }
        }
      ).then(e => Buffer.from(e.edition, 'base64').toString('binary'))
      // .pipe(new stream.PassThrough())
    },
    // beneficiary,
    date: new Date(),
    // isThirdPartyPayer,
    groupAmount: 10,
    // originalDate: parseDate(originalDate),
    // subtype,
    // originalAmount,
    // socialSecurityRefund,
    amount: 10,
    filename: 'test.pdf',
    vendor: 'lamutuellegenerale',
    type: 'health_costs',
    currency: '€',
    isRefund: true,
    metadata: {
      importDate: new Date(),
      version: 1
    },
    requestOptions: {
      form: {
        debutPeriode: '2021-04-01',
        finPeriode: '2021-04-30',
        tri: 'DATE_PAIEMENT',
        mock: 'false'
      },
      headers: {
        'api-key': API_KEY,
        Authorization: `${token.token_type} ${token.access_token}`,
        idPersonneUtilisateur: token.golden_id,
        appRequestCode: 'EspaceAdherent'
      }
    }
  }

  const documents = [bill]
  await saveBills(documents, fields, {
    identifiers: ['la mutuelle gen']
  })

  // log('info', 'Parsing list of bills')
  // const documents = await parseBills($)

  // log('info', 'Saving data to Cozy')
  // await saveBills(documents, fields, {
  //   identifiers: ['la mutuelle gen']
  // })
}

async function authenticate(username, password) {
  // prepare code_challenge
  const code_verifier = generateRandom(43)
  const code_challenge = btoa(
    crypto
      .createHash('sha256')
      .update(code_verifier)
      .digest('hex')
  )

  // call to /oidc/authorize
  const redirect_url = `https://adherent.lamutuellegenerale.fr/&code_challenge=${code_challenge}&code_challenge_method=S256`
  var response = await request(
    `${BASE_URL}/oidc/authorize?response_type=code&scope=openid&client_id=${OIDC_CLIENT_ID}&state=Any-state-5s5ze8g85d&redirect_uri=${redirect_url}`,
    {
      resolveWithFullResponse: true
    }
  )
  const params = extractParams(response.request.uri.search)
  const oidcLoginUri = response.request.uri.href

  // call to oidc/login
  response = await request.post(oidcLoginUri, {
    form: {
      sessionID: params['sessionID'],
      sessionData: '',
      username: username,
      password: password,
      state: 'submit'
    },
    transform: body => cheerio.load(body)
  })

  const [action, inputs] = parseForm(response, 'form', oidcLoginUri)

  response = await request.post({
    uri: require('url').resolve(oidcLoginUri, action),
    method: 'POST',
    form: { ...inputs },
    transform: (body, response) => [cheerio.load(body), response],
    headers: {
      Referer: oidcLoginUri
    }
  })

  code = extractParams(response[1].socket._httpMessage.path)['code']

  log('debug', code, 'code')

  response = request.post(`${BASE_URL}/oidc/token`, {
    resolveWithFullResponse: true,
    json: true,
    form: {
      grant_type: 'authorization_code',
      code: code,
      client_id: OIDC_CLIENT_ID,
      code_verifier: code_verifier,
      redirect_uri: 'https://adherent.lamutuellegenerale.fr/'
    },
    headers: {
      'api-key': API_KEY
    },
    transform: body => body
  })

  return response
}

function generateRandom(e = 5) {
  let t = ''
  const n = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-'
  for (let i = 0; i < e; i++)
    t += n.charAt(Math.floor(Math.random() * n.length))
  return t
}

function atob(str) {
  return Buffer.from(str, 'base64').toString('binary')
}

function btoa(str) {
  if (str instanceof Buffer) {
    return str.toString('base64')
  } else {
    return Buffer.from(str.toString(), 'binary').toString('base64')
  }
}

function extractParams(url) {
  const params = {}
  url.replace(/[?&]+([^=&]+)=([^&]*)/gi, function(m, key, value) {
    params[key] = value
  })
  return params
}

function parseForm($, formSelector, currentUrl) {
  const form = $(formSelector).first()
  const action = form.attr('action') || currentUrl

  if (!form.is('form')) {
    const err = 'element matching `' + formSelector + '` is not a `form`'
    log('error', err)
    throw new Error('INVALID_FORM')
  }

  const inputs = {}
  const arr = form.serializeArray()

  for (let input of arr) {
    inputs[input.name] = input.value
  }

  return [action, inputs]
}

async function getIdentity(token) {
  const accueilCompte = await request(
    `${BASE_URL}/espaceadherent/V1/moncompte/accueilCompte`,
    {
      json: true,
      headers: {
        'api-key': API_KEY,
        Authorization: `${token.token_type} ${token.access_token}`,
        idPersonneUtilisateur: token.golden_id,
        appRequestCode: 'EspaceAdherent'
      }
    }
  )
  const infosPersonnelles = await request(
    `${BASE_URL}/espaceadherent/V1/moncompte/infosPersonnelles`,
    {
      json: true,
      headers: {
        'api-key': API_KEY,
        Authorization: `${token.token_type} ${token.access_token}`,
        idPersonneUtilisateur: token.golden_id,
        appRequestCode: 'EspaceAdherent'
      }
    }
  )

  const phone = []
  // pas de tel fixe perso donc je n'ai pas la clé dans le json retourné
  // if (accueilCompte.infosAccueil.infosPerso.telephoneFixe) {
  //   phone.push({
  //     type: 'home',
  //     number: accueilCompte.infosAccueil.infosPerso.telephoneFixe
  //   })
  // }

  if (accueilCompte.infosAccueil.infosPerso.telephonePortable) {
    phone.push({
      type: 'mobile',
      number: accueilCompte.infosAccueil.infosPerso.telephonePortable
    })
  }

  let email = [{ address: accueilCompte.infosAccueil.infosPerso.email }]

  let address = [
    { formatedAddress: accueilCompte.infosAccueil.infosPerso.adresse }
  ]

  const contact = {
    name: {
      givenName: infosPersonnelles.informationsPersonnelles.prenom,
      familyName: infosPersonnelles.informationsPersonnelles.nom
    },
    // socialSecurityNumber: infosPersonnelles.informationsPersonnelles.informationsSS.numeroSS,
    birthday: infosPersonnelles.informationsPersonnelles.profil.dateNaissance,
    phone,
    address,
    email
  }

  return contact
}
