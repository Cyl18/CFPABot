git pull
docker build -f "CFPABot/Dockerfile" -t docker.cyan.cafe/cfpabot .
docker image push docker.cyan.cafe/cfpabot:latest