#See https://aka.ms/containerfastmode to understand how Visual Studio uses this Dockerfile to build your images for faster debugging.

FROM mcr.microsoft.com/dotnet/aspnet:5.0 AS base
RUN printf "deb http://mirrors.tuna.tsinghua.edu.cn/debian/ buster main contrib non-free\ndeb http://mirrors.tuna.tsinghua.edu.cn/debian/ buster-updates main contrib non-free\ndeb http://mirrors.tuna.tsinghua.edu.cn/debian/ buster-backports main contrib non-free\ndeb http://mirrors.tuna.tsinghua.edu.cn/debian-security buster/updates main contrib non-free" > /etc/apt/sources.list
RUN apt -y update && apt install -y git && apt install -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
EXPOSE 80

FROM mcr.microsoft.com/dotnet/sdk:5.0 AS build
WORKDIR /src
COPY ["CFPABot/CFPABot.csproj", "CFPABot/"]
RUN dotnet restore "CFPABot/CFPABot.csproj"
COPY . .
WORKDIR "/src/CFPABot"
RUN dotnet build "CFPABot.csproj" -c Release -o /app/build

FROM build AS publish
RUN dotnet publish "CFPABot.csproj" -c Release -o /app/publish

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENV LD_LIBRARY_PATH=/app/runtimes/debian.9-x64/native/
HEALTHCHECK --interval=5s --timeout=10s --retries=3 CMD curl --fail http://127.0.0.1:80/healthcheck || exit 1
ENTRYPOINT ["dotnet", "CFPABot.dll"]