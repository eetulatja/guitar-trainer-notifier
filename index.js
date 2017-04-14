import Promise from 'bluebird';
import request from 'request-promise';
import moment from 'moment';
import _ from 'lodash';
import 'colors';
import Koa from 'koa';
import KoaRouter from 'koa-router';
import mailgun from 'mailgun-js';
import config from 'config';


const mailgunClient = mailgun({
	apiKey: config.get('apiKey'),
	domain: config.get('domain'),
});


let previousLessons = [];


async function login() {
	await request({
		url: config.get('url'),
		jar: true,
	});

	const text = await request({
		url: config.get('loginUrl'),
		method: 'POST',
		form: {
			name: config.get('login.name'),
			password: config.get('login.password'),
		},
		jar: true,
		followAllRedirects: true,
	});
}

async function getLessons() {
	process.stdout.write('Fetching lessons...');

	const now = moment();
	const after2Months = moment(now).add(2, 'month');

	const response = await request({
		url: config.get('lessonsUrl'),
		qs: {
			afrom: now.format('YYYY-MM-DD HH:mm'),
			ato: after2Months.format('YYYY-MM-DD HH:mm'),
		},
		jar: true,
	});

	const {
		app: rawLessons,
		mine: myLessonIds,
	} = JSON.parse(response);

	const lessons = rawLessons.map(rawLesson => {
		const id = rawLesson[2];
		const startDate = moment(1000 * rawLesson[0]).utcOffset(0);
		const endDate = moment(1000 * rawLesson[1]).utcOffset(0);
		const typeName = rawLesson[7];
		const hasSpace = rawLesson[3] === -1 && rawLesson[4] === -1;
		const reservation = _.includes(myLessonIds, id);

		const lesson = {
			id,
			startDate,
			endDate,
			typeName,
			hasSpace,
			reservation,
		};

		return lesson;
	});

	process.stdout.write(`DONE Fetched ${lessons.length} lessons.\n`);

	return lessons;
}

function printLessons(lessons) {
	const lessonsByDate = _.groupBy(lessons, ({ startDate }) => startDate.format('YYYY-MM-DD'));

	for (const [ date, lessons ] of Object.entries(lessonsByDate)) {
		console.log(date);
		for (let { typeName, reservation, hasSpace } of lessons) {
			if (!hasSpace) {
				typeName = typeName.grey;
			}
			const reserved = reservation ? 'X'.green : ' ';
			console.log(`  ${reserved} ${typeName}`);
		}
	}
}

async function getNewLessons() {
	const newLessons = await getLessons();

	const freedLessons = [];
	for (const newLesson of newLessons) {
		const oldLesson = _.find(previousLessons, ({ id }) => newLesson.id === id);

		if (!oldLesson) {
			freedLessons.push(newLesson);
		}
		else {
			const wasFreed = !oldLesson.hasSpace && newLesson.hasSpace;
			const reserved = oldLesson.reservation || newLesson.reservation;

			if (wasFreed && !reserved) {
				freedLessons.push(newLesson);
			}
			if (wasFreed) {
				freedLessons.push(newLesson);
			}
		}
	}

	previousLessons = newLessons;

	if (freedLessons.length > 0) {
		await sendMail(freedLessons);
	}

	console.log(moment().format('YYYY-MM-DD HH:mm:ss'));
	console.log(freedLessons.length);
}

async function startHttpServer() {
	process.stdout.write('Starting HTTP server...');

	const app = new Koa();
	const router = new KoaRouter();

	router.post('/refresh', async (ctx, next) => {
		await getNewLessons();

		ctx.body = { message: 'Lessons reservation data refreshed.' };
	});

	app.use(router.routes());

	await new Promise(resolve => app.listen(5000, resolve));

	process.stdout.write('DONE\n');
}

async function sendMail(lessons) {
	process.stdout.write('Sending email...');

	const body = 'Freed lessons:\n\n' + _.chain(lessons)
		.groupBy(({ startDate }) => startDate.format('ddd D.M.'))
		.map((lessons, date) => {
			const lessonsText = lessons
				.map(({ typeName, startDate, endDate }) => {
					return `  ${startDate.format('HH:mm')} - ${endDate.format('HH:mm')} ${typeName}`;
				})
				.join('\n');

			return date + '\n' + lessonsText;
		})
		.join('\n\n')
		.value();

	const data = {
		from: config.get('mail.from'),
		to: config.get('mail.to'),
		subject: config.get('mail.subject'),
		text: body,
	};

	const response = await mailgunClient.messages().send(data);

	process.stdout.write('DONE\n');

	console.log(body)
}


async function main() {
	process.stdout.write('Logging in...');
	await login();
	process.stdout.write('DONE\n');

	previousLessons = await getLessons();

	await startHttpServer();

	setInterval(getNewLessons, 10 * 60 * 1000);
}

Promise.resolve(main()).done();
