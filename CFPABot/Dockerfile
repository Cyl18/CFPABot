#See https://aka.ms/containerfastmode to understand how Visual Studio uses this Dockerfile to build your images for faster debugging.

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone
RUN printf "deb https://mirrors.tuna.tsinghua.edu.cn/debian/ bullseye main contrib non-free\ndeb https://mirrors.tuna.tsinghua.edu.cn/debian/ bullseye-updates main contrib non-free\ndeb https://mirrors.tuna.tsinghua.edu.cn/debian/ bullseye-backports main contrib non-free\ndeb https://mirrors.tuna.tsinghua.edu.cn/debian-security bullseye-security main contrib non-free" > /etc/apt/sources.list
RUN apt -y update && apt install -y git && apt install -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
EXPOSE 80

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS publish
WORKDIR /src
COPY ["CFPABot/CFPABot.csproj", "CFPABot/"]
RUN dotnet restore "CFPABot/CFPABot.csproj" 
COPY . .
RUN dotnet clean CFPABot.sln --configuration "Debug"
WORKDIR "/src/CFPABot"
RUN rm -rf bin && rm -rf obj
RUN  dotnet publish "CFPABot.csproj" -r debian.9-x64 --no-self-contained -c Debug -o /app/publish && mkdir -p /app/publish/wwwrootx/css && cp /src/CFPABot/obj/Debug/net7.0/debian.9-x64/scopedcss/bundle/CFPABot.styles.css /app/publish/wwwrootx/css/

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENV LD_LIBRARY_PATH=/app/runtimes/debian.9-x64/native/
HEALTHCHECK --interval=5s --timeout=10s --retries=3 CMD curl --fail http://127.0.0.1:80/healthcheck || exit 1
ENTRYPOINT ["dotnet", "CFPABot.dll"]